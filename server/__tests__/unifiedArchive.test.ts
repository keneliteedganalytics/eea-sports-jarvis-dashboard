// v6.7.7: the unified archive spans game-line + player-prop ledgers. Proves:
//   • type=ALL surfaces both kinds (graded);
//   • tier=PASS returns only PASS rows (both kinds);
//   • type=prop&tier=SNIPER returns only graded actionable props;
//   • passPicks() == unifiedArchive({tier:'PASS'}).
// Run: tsx server/__tests__/unifiedArchive.test.ts

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graded-unified-"));
process.env.GRADED_BOOK_PATH = path.join(tmpDir, "test_book.db");
process.env.BANKROLL_USD = "25000";

const {
  gradedDb, upsertPropPick, upsertPick,
  unifiedArchive, passPicks,
} = await import("../gradedBook");
const { gradePropPick } = await import("../sports/props/gradeProp");

const db = gradedDb();

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err as Error).message}`);
  }
}

console.log("unified archive (v6.7.7)");

// ── Seed both ledgers ────────────────────────────────────────────────────────
// A graded, actionable prop (SNIPER, settled W).
upsertPropPick({
  pick_id: "uProp1", sport: "mlb", game_id: "ug1", player_name: "Star Hitter",
  market_type: "batter_hits", line: 1.5, side: "over", posted_odds: 100,
  tier: "SNIPER", edge_pp: 7, posted_at: "2026-06-09T18:00:00Z",
});
gradePropPick("uProp1", 2); // → W

// A PASS prop (recorded, never played).
upsertPropPick({
  pick_id: "uPropPass", sport: "mlb", game_id: "ug2", player_name: "Cold Bat",
  market_type: "batter_hits", line: 2.5, side: "over", posted_odds: -110,
  tier: "PASS", pass_reason: "model_outlier_v676", edge_pp: 18, stake_units: 0,
  posted_at: "2026-06-09T18:00:00Z",
});

// A graded game-line play in the permanent ledger.
db.prepare(
  `INSERT INTO pick_history (pick_id, sport, graded_at, pick_label, tier, result, pl_units, pl_dollars, posted_odds)
   VALUES (@pick_id, @sport, @graded_at, @pick_label, @tier, @result, @pl_units, @pl_dollars, @posted_odds)`,
).run({
  pick_id: "uGame1", sport: "mlb", graded_at: "2026-06-09T23:00:00Z",
  pick_label: "Home Team ML", tier: "EDGE", result: "W",
  pl_units: 1.1, pl_dollars: 110, posted_odds: -110,
});

// A PASS game-line pick on the live board. upsertPick composes the row id as
// `${gameId}:${pickType}:${pickSide}`, so the unified pick_id is this:
const uggPassId = "uggPass:ML:home";
upsertPick({
  gameId: "uggPass", sport: "mlb", gameDate: "2026-06-09", gameTimeEt: "7:00 PM ET",
  matchup: "X @ Y", homeTeam: "Y", awayTeam: "X", homeTeamFull: "Y Team",
  awayTeamFull: "X Team", pickSide: "home", pickTeam: "Y", pickTeamFull: "Y Team",
  pickType: "ML", pickLine: null, pickMl: -120, pickBook: "dk", gameStartIso: null,
  tier: "PASS", units: 0, stakeDollars: 0, pickWinProb: 0.5, pickImpliedProb: 0.54,
  edgePp: 1, evPer100: 1, confidence: 40, fairMl: -110, pass_reason: "daily_cap",
});

await test("type=ALL (default) returns graded plays of BOTH kinds, no PASS", () => {
  const page = unifiedArchive({ type: "ALL" });
  const ids = page.items.map((i) => i.pick_id);
  assert.ok(ids.includes("uProp1"), "graded prop present");
  assert.ok(ids.includes("uGame1"), "graded game-line present");
  assert.ok(!ids.includes("uPropPass"), "PASS prop excluded by default");
  assert.ok(!ids.includes(uggPassId), "PASS game-line excluded by default");
  assert.ok(page.items.some((i) => i.kind === "prop") && page.items.some((i) => i.kind === "game"));
});

await test("tier=PASS returns only PASS rows across both kinds", () => {
  const page = unifiedArchive({ type: "ALL", tier: "PASS" });
  const ids = page.items.map((i) => i.pick_id);
  assert.ok(ids.includes("uPropPass"), "PASS prop surfaced");
  assert.ok(ids.includes(uggPassId), "PASS game-line surfaced");
  assert.ok(!ids.includes("uProp1") && !ids.includes("uGame1"), "graded plays excluded");
  assert.ok(page.items.every((i) => i.tier === "PASS"));
});

await test("type=prop&tier=SNIPER returns only graded actionable props", () => {
  const page = unifiedArchive({ type: "prop", tier: "SNIPER" });
  assert.ok(page.items.every((i) => i.kind === "prop" && i.tier === "SNIPER"));
  assert.ok(page.items.some((i) => i.pick_id === "uProp1"));
  assert.ok(!page.items.some((i) => i.pick_id === "uPropPass"));
});

await test("reason filter narrows the PASS pile", () => {
  const page = passPicks({ type: "ALL", reason: "model_outlier_v676" });
  assert.ok(page.items.some((i) => i.pick_id === "uPropPass"));
  assert.ok(!page.items.some((i) => i.pick_id === uggPassId), "daily_cap PASS excluded by reason filter");
});

await test("passPicks() equals unifiedArchive({tier:'PASS'})", () => {
  const a = passPicks({ type: "ALL" }).items.map((i) => i.pick_id).sort();
  const b = unifiedArchive({ type: "ALL", tier: "PASS" }).items.map((i) => i.pick_id).sort();
  assert.deepEqual(a, b);
});

await test("type=game narrows to game-line only", () => {
  const page = unifiedArchive({ type: "game", tier: "PASS" });
  assert.ok(page.items.every((i) => i.kind === "game"));
  assert.ok(page.items.some((i) => i.pick_id === uggPassId));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
