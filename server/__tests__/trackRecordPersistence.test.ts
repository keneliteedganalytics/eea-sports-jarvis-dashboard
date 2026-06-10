// Track Record + Analytics aggregate from the permanent pick_history ledger, so
// lifetime stats survive a wipe of the live picks table. This proves feature B:
// grade some picks, delete every live pick row, and confirm the summaries still
// report the full record. Run: tsx server/__tests__/trackRecordPersistence.test.ts

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graded-tr-persist-"));
process.env.GRADED_BOOK_PATH = path.join(tmpDir, "test_book.db");
process.env.BANKROLL_USD = "25000";

const { gradedDb, upsertPick, pickId, settlePick, recordGradeLedger, pickHistoryCount } =
  await import("../gradedBook");
const { trackRecord } = await import("../sports/mlb/trackRecord");
const { buildAnalytics } = await import("../analytics");

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

function gradeOne(suffix: string, sport: string, result: "W" | "L" | "P", ml: number, pl: number): void {
  const id = pickId(`g${suffix}`, "ML", "home");
  upsertPick({
    gameId: `g${suffix}`, sport, gameDate: "2026-06-08", gameTimeEt: "7:05 PM ET",
    matchup: "AAA @ BBB", homeTeam: "BBB", awayTeam: "AAA",
    homeTeamFull: "B", awayTeamFull: "A",
    pickSide: "home", pickTeam: "BBB", pickTeamFull: "B", pickType: "ML",
    pickLine: null, pickMl: ml, pickBook: "DK", gameStartIso: "2026-06-08T23:05:00Z",
    tier: "EDGE", units: 1, stakeDollars: 500,
    pickWinProb: 0.5, pickImpliedProb: 0.5, edgePp: 0, evPer100: 0, confidence: 60, fairMl: ml,
  });
  settlePick(id, { finalAwayScore: 1, finalHomeScore: 2, result, pl, clvPct: 2.0, liveStatusDetail: "Final" });
  recordGradeLedger(id);
}

console.log("Track Record persistence (survives a live-book wipe)");

gradeOne("W1", "mlb", "W", 100, 1);
gradeOne("L1", "mlb", "L", -110, -1);
gradeOne("W2", "mlb", "W", 150, 1.5);

await test("track record reflects the three graded picks", () => {
  const tr = trackRecord("MLB");
  assert.equal(tr.totalBets, 3);
  assert.equal(tr.record.wins, 2);
  assert.equal(tr.record.losses, 1);
  assert.equal(tr.betLog.length, 3);
});

await test("wiping the live picks table leaves history (and stats) intact", () => {
  const db = gradedDb();
  db.prepare("DELETE FROM picks").run();
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM picks").get() as { n: number }).n, 0);
  assert.equal(pickHistoryCount(), 3, "pick_history is never deleted");

  const tr = trackRecord("MLB");
  assert.equal(tr.totalBets, 3, "track record still reports all graded picks");
  assert.equal(tr.record.wins, 2);
  assert.equal(tr.record.losses, 1);
});

await test("analytics KPIs survive the wipe too (they share the ledger)", () => {
  const a = buildAnalytics({ sport: "MLB", tier: "ALL", since: null });
  assert.equal(a.kpis.totalBets, 3);
  assert.equal(a.kpis.winRatePct, 66.7); // 2 of 3 decided
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
