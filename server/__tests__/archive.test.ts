// Archive: paginated/filtered view over the permanent pick_history (archived_at
// IS NOT NULL), the final-score composition, and slate exclusion of archived
// (final) picks. Network-free — seeds a temp graded book directly.
// Run: tsx server/__tests__/archive.test.ts

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graded-archive-"));
process.env.GRADED_BOOK_PATH = path.join(tmpDir, "test_book.db");
process.env.BANKROLL_USD = "25000";

const {
  forceInsertPick, settlePick, recordGradeLedger, pickId, gradedDb,
  archivedPicks, archivedPickIds,
} = await import("../gradedBook");
const { excludeArchivedPicks } = await import("../slate/orchestrator");
import type { UpsertPickInput } from "../gradedBook";
import type { BuiltPick } from "../sports/mlb/picksEngine";

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err as Error).message}`);
  }
}

// Seed a graded (final) pick that lands in pick_history with archived_at set.
function seedFinal(opts: {
  gameId: string; sport: string; tier: string; result: "W" | "L" | "P";
  pickMl: number; gradedDay: string; fa: number; fh: number;
}): string {
  const input: UpsertPickInput = {
    gameId: opts.gameId, sport: opts.sport, gameDate: opts.gradedDay, gameTimeEt: "7:05 PM",
    matchup: `AWY @ HOM (${opts.gameId})`, homeTeam: "HOM", awayTeam: "AWY",
    homeTeamFull: "Home", awayTeamFull: "Away",
    pickSide: "home", pickTeam: "HOM", pickTeamFull: "Home", pickType: "ML",
    pickLine: null, pickMl: opts.pickMl, pickBook: "test",
    gameStartIso: `${opts.gradedDay}T23:05:00Z`,
    tier: opts.tier, units: 1, stakeDollars: 100,
    pickWinProb: 0.55, pickImpliedProb: 0.5, edgePp: 5, evPer100: 4, confidence: 70, fairMl: -120,
  };
  const id = forceInsertPick(input);
  settlePick(id, {
    finalAwayScore: opts.fa, finalHomeScore: opts.fh,
    result: opts.result, pl: opts.result === "W" ? 1 : opts.result === "L" ? -1 : 0,
    clvPct: 2.5, liveStatusDetail: "Final",
  });
  // Pin graded_at to a deterministic day so `since` filters are testable.
  gradedDb().prepare("UPDATE picks SET gradedAt=@g WHERE id=@id").run({
    g: `${opts.gradedDay}T23:30:00Z`, id,
  });
  recordGradeLedger(id);
  return id;
}

console.log("archive");

const winId = seedFinal({ gameId: "arch-w", sport: "mlb", tier: "SNIPER", result: "W", pickMl: 120, gradedDay: "2026-06-01", fa: 3, fh: 5 });
const lossId = seedFinal({ gameId: "arch-l", sport: "nhl", tier: "EDGE", result: "L", pickMl: -110, gradedDay: "2026-06-05", fa: 2, fh: 1 });
const pushId = seedFinal({ gameId: "arch-p", sport: "nba", tier: "RECON", result: "P", pickMl: -105, gradedDay: "2026-06-08", fa: 4, fh: 4 });

test("all three graded picks are archived", () => {
  const page = archivedPicks();
  assert.equal(page.total, 3);
  assert.equal(page.items.length, 3);
});

test("newest graded sorts first", () => {
  const items = archivedPicks().items;
  assert.equal(items[0].pick_id, pushId); // 2026-06-08
  assert.equal(items[2].pick_id, winId);  // 2026-06-01
});

test("final_score composes from stored scores + teams", () => {
  const win = archivedPicks().items.find((i) => i.pick_id === winId)!;
  assert.equal(win.final_score, "AWY 3 — HOM 5");
});

test("result filter narrows to W / L / P", () => {
  assert.equal(archivedPicks({ result: "W" }).total, 1);
  assert.equal(archivedPicks({ result: "L" }).total, 1);
  assert.equal(archivedPicks({ result: "P" }).total, 1);
  assert.equal(archivedPicks({ result: "W" }).items[0].pick_id, winId);
});

test("sport filter narrows the page", () => {
  const nhl = archivedPicks({ sport: "NHL" });
  assert.equal(nhl.total, 1);
  assert.equal(nhl.items[0].pick_id, lossId);
});

test("tier filter narrows the page", () => {
  const sniper = archivedPicks({ tier: "SNIPER" });
  assert.equal(sniper.total, 1);
  assert.equal(sniper.items[0].pick_id, winId);
});

test("since lower-bounds on graded_at (inclusive)", () => {
  // 2026-06-05 cutoff keeps the loss (06-05) and push (06-08), drops the win (06-01).
  const page = archivedPicks({ since: "2026-06-05" });
  assert.equal(page.total, 2);
  assert.ok(!page.items.some((i) => i.pick_id === winId));
});

test("limit + offset paginate, total stays the full count", () => {
  const p1 = archivedPicks({ limit: 2, offset: 0 });
  assert.equal(p1.total, 3);
  assert.equal(p1.items.length, 2);
  assert.equal(p1.limit, 2);
  const p2 = archivedPicks({ limit: 2, offset: 2 });
  assert.equal(p2.items.length, 1);
  assert.equal(p2.offset, 2);
  // No overlap between pages.
  const ids = new Set(p1.items.map((i) => i.pick_id));
  assert.ok(!p2.items.some((i) => ids.has(i.pick_id)));
});

test("limit is clamped to [1, 200]", () => {
  assert.equal(archivedPicks({ limit: 0 }).limit, 50); // 0 → default 50
  assert.equal(archivedPicks({ limit: 9999 }).limit, 200);
});

test("archivedPickIds returns the full set of archived ids", () => {
  const ids = archivedPickIds();
  assert.ok(ids.has(winId));
  assert.ok(ids.has(lossId));
  assert.ok(ids.has(pushId));
  assert.equal(ids.size, 3);
});

// ── Slate exclusion ─────────────────────────────────────────────────────────
function boardPick(gameId: string, gradeStatus?: "pending" | "in_progress" | "final"): BuiltPick {
  return { gameId, pickType: "ML", pickSide: "home", gradeStatus } as unknown as BuiltPick;
}

test("excludeArchivedPicks drops final picks and archived ids, keeps live/pending", () => {
  const board: BuiltPick[] = [
    boardPick("arch-w"),                 // archived id → dropped
    boardPick("fresh-1", "pending"),     // kept
    boardPick("fresh-2", "in_progress"), // kept
    boardPick("fresh-3", "final"),       // final status → dropped
  ];
  const kept = excludeArchivedPicks(board);
  const ids = kept.map((p) => p.gameId);
  assert.ok(!ids.includes("arch-w"));
  assert.ok(!ids.includes("fresh-3"));
  assert.ok(ids.includes("fresh-1"));
  assert.ok(ids.includes("fresh-2"));
  assert.equal(kept.length, 2);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
