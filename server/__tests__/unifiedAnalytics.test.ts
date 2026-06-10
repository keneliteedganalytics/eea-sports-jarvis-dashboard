// v6.7.7: /api/analytics now subsumes player props. Proves:
//   • graded prop rows contribute to the combined KPIs (totalBets/netUnits);
//   • byKind splits the record into game + prop;
//   • byTier counts played actionable tiers across both kinds;
//   • passSummary counts PASS rows from BOTH ledgers with a reason breakdown.
// Run: tsx server/__tests__/unifiedAnalytics.test.ts

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graded-analytics-"));
process.env.GRADED_BOOK_PATH = path.join(tmpDir, "test_book.db");
process.env.BANKROLL_USD = "25000";

const { gradedDb, upsertPropPick, upsertPick } = await import("../gradedBook");
const { gradePropPick } = await import("../sports/props/gradeProp");
const { buildAnalytics } = await import("../analytics");

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

console.log("unified analytics (v6.7.7)");

// ── Seed ─────────────────────────────────────────────────────────────────────
// Two graded actionable props (a SNIPER W and an EDGE L).
upsertPropPick({
  pick_id: "aProp1", sport: "mlb", game_id: "ag1", player_name: "Hot Bat",
  market_type: "batter_hits", line: 1.5, side: "over", posted_odds: -110,
  tier: "SNIPER", edge_pp: 9, posted_at: "2026-06-09T18:00:00Z",
});
gradePropPick("aProp1", 2); // → W

upsertPropPick({
  pick_id: "aProp2", sport: "mlb", game_id: "ag2", player_name: "Mid Bat",
  market_type: "batter_total_bases", line: 2.5, side: "over", posted_odds: -110,
  tier: "EDGE", edge_pp: 5, posted_at: "2026-06-09T18:00:00Z",
});
gradePropPick("aProp2", 1); // → L

// A graded game-line play in the permanent ledger (so trackRecord/byKind game side
// is non-empty). final_*_score present so it composes a final score.
db.prepare(
  `INSERT INTO pick_history (pick_id, sport, graded_at, pick_label, tier, result, stake_units, stake_dollars, pl_units, pl_dollars, posted_odds)
   VALUES (@pick_id, @sport, @graded_at, @pick_label, @tier, @result, @stake_units, @stake_dollars, @pl_units, @pl_dollars, @posted_odds)`,
).run({
  pick_id: "aGame1", sport: "mlb", graded_at: "2026-06-09T23:00:00Z",
  pick_label: "Home Team ML", tier: "SNIPER", result: "W",
  stake_units: 1, stake_dollars: 100, pl_units: 0.9, pl_dollars: 90, posted_odds: -110,
});

// PASS rows in BOTH ledgers, with distinct reasons.
upsertPropPick({
  pick_id: "aPropPass", sport: "mlb", game_id: "ag3", player_name: "Cold Bat",
  market_type: "batter_hits", line: 2.5, side: "over", posted_odds: -110,
  tier: "PASS", pass_reason: "model_outlier_v676", edge_pp: 18, stake_units: 0,
  posted_at: "2026-06-09T18:00:00Z",
});
upsertPick({
  gameId: "aggPass", sport: "mlb", gameDate: "2026-06-09", gameTimeEt: "7:00 PM ET",
  matchup: "X @ Y", homeTeam: "Y", awayTeam: "X", homeTeamFull: "Y Team",
  awayTeamFull: "X Team", pickSide: "home", pickTeam: "Y", pickTeamFull: "Y Team",
  pickType: "ML", pickLine: null, pickMl: -120, pickBook: "dk", gameStartIso: null,
  tier: "PASS", units: 0, stakeDollars: 0, pickWinProb: 0.5, pickImpliedProb: 0.54,
  edgePp: 1, evPer100: 1, confidence: 40, fairMl: -110, pass_reason: "daily_cap",
});

await test("byKind splits the graded record into game + prop", () => {
  const a = buildAnalytics({});
  const prop = a.byKind.find((k) => k.kind === "prop");
  const game = a.byKind.find((k) => k.kind === "game");
  assert.ok(prop && game, "both kinds present");
  assert.equal(prop!.bets, 2, "two graded props");
  assert.equal(prop!.wins, 1);
  assert.equal(prop!.losses, 1);
  assert.equal(game!.bets, 1, "one graded game-line");
  assert.equal(game!.wins, 1);
});

await test("combined KPIs include prop rows in totalBets and netUnits", () => {
  const a = buildAnalytics({});
  assert.equal(a.kpis.totalBets, 3, "1 game + 2 props");
  // game +0.9, prop1 +~0.91 (W -110), prop2 -1 (L) → net > 0.
  assert.ok(a.kpis.netUnits > 0, `expected positive combined net, got ${a.kpis.netUnits}`);
});

await test("byTier counts played actionable tiers across both kinds", () => {
  const a = buildAnalytics({});
  const sniper = a.byTier.find((t) => t.tier === "SNIPER");
  const edge = a.byTier.find((t) => t.tier === "EDGE");
  assert.equal(sniper!.bets, 2, "1 game SNIPER + 1 prop SNIPER");
  assert.equal(edge!.bets, 1, "1 prop EDGE");
  assert.ok(!a.byTier.some((t) => t.tier === "PASS"), "PASS is never a played tier");
});

await test("passSummary counts PASS rows from both ledgers with reason breakdown", () => {
  const a = buildAnalytics({});
  assert.equal(a.passSummary.passed, 2, "1 prop PASS + 1 game PASS");
  assert.equal(a.passSummary.passReasonBreakdown.model_outlier_v676, 1);
  assert.equal(a.passSummary.passReasonBreakdown.daily_cap, 1);
  // totalEvaluated counts every recorded row across both tables.
  assert.ok(a.passSummary.totalEvaluated >= a.passSummary.passed);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
