// v6.7.7: the Passes pile (backing GET /api/passes) is passPicks(). Proves:
//   • it returns ONLY tier='PASS' rows across both ledgers;
//   • the ?reason= filter narrows to a single pass_reason;
//   • type=game|prop narrows the pile to one kind;
//   • graded/actionable picks never leak into the pile.
// Run: tsx server/__tests__/passesEndpoint.test.ts

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graded-passes-"));
process.env.GRADED_BOOK_PATH = path.join(tmpDir, "test_book.db");
process.env.BANKROLL_USD = "25000";

const { gradedDb, upsertPropPick, upsertPick, passPicks } = await import("../gradedBook");
const { gradePropPick } = await import("../sports/props/gradeProp");

gradedDb();

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

console.log("passes endpoint (v6.7.7)");

// ── Seed ─────────────────────────────────────────────────────────────────────
// A graded actionable prop — must NEVER appear in the pile.
upsertPropPick({
  pick_id: "pPlay", sport: "mlb", game_id: "pg0", player_name: "Star",
  market_type: "batter_hits", line: 1.5, side: "over", posted_odds: -110,
  tier: "SNIPER", edge_pp: 9, posted_at: "2026-06-09T18:00:00Z",
});
gradePropPick("pPlay", 2);

// Two PASS props with different reasons.
upsertPropPick({
  pick_id: "pPropA", sport: "mlb", game_id: "pg1", player_name: "Cold A",
  market_type: "batter_hits", line: 2.5, side: "over", posted_odds: -110,
  tier: "PASS", pass_reason: "model_outlier_v676", edge_pp: 18, stake_units: 0,
  posted_at: "2026-06-09T18:00:00Z",
});
upsertPropPick({
  pick_id: "pPropB", sport: "mlb", game_id: "pg2", player_name: "Cold B",
  market_type: "batter_total_bases", line: 3.5, side: "over", posted_odds: -110,
  tier: "PASS", pass_reason: "below_threshold", edge_pp: 2, stake_units: 0,
  posted_at: "2026-06-09T18:00:00Z",
});

// A PASS game-line pick (daily_cap).
const ggPassId = "pgGame:ML:home";
upsertPick({
  gameId: "pgGame", sport: "mlb", gameDate: "2026-06-09", gameTimeEt: "7:00 PM ET",
  matchup: "X @ Y", homeTeam: "Y", awayTeam: "X", homeTeamFull: "Y Team",
  awayTeamFull: "X Team", pickSide: "home", pickTeam: "Y", pickTeamFull: "Y Team",
  pickType: "ML", pickLine: null, pickMl: -120, pickBook: "dk", gameStartIso: null,
  tier: "PASS", units: 0, stakeDollars: 0, pickWinProb: 0.5, pickImpliedProb: 0.54,
  edgePp: 1, evPer100: 1, confidence: 40, fairMl: -110, pass_reason: "daily_cap",
});

await test("the pile is tier=PASS only — no graded play leaks in", () => {
  const page = passPicks({ type: "ALL" });
  assert.ok(page.items.length >= 3, "all three PASS rows present");
  assert.ok(page.items.every((i) => i.tier === "PASS"), "every row is PASS");
  assert.ok(!page.items.some((i) => i.pick_id === "pPlay"), "graded play excluded");
});

await test("?reason= narrows to a single pass_reason", () => {
  const page = passPicks({ type: "ALL", reason: "below_threshold" });
  const ids = page.items.map((i) => i.pick_id);
  assert.ok(ids.includes("pPropB"), "below_threshold prop present");
  assert.ok(!ids.includes("pPropA"), "model_outlier prop excluded");
  assert.ok(!ids.includes(ggPassId), "daily_cap game excluded");
  assert.ok(page.items.every((i) => i.pass_reason === "below_threshold"));
});

await test("type=prop narrows the pile to props only", () => {
  const page = passPicks({ type: "prop" });
  assert.ok(page.items.every((i) => i.kind === "prop"));
  assert.ok(!page.items.some((i) => i.pick_id === ggPassId), "game PASS excluded");
});

await test("type=game narrows the pile to game-line only", () => {
  const page = passPicks({ type: "game" });
  assert.ok(page.items.every((i) => i.kind === "game"));
  assert.ok(page.items.some((i) => i.pick_id === ggPassId), "game PASS present");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
