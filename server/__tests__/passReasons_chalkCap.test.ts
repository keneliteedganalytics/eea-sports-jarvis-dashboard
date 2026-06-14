// chalk_cap pass reason (v6.8.1). A pick demoted by the SNIPER chalk cap is
// recorded as tier='PASS' with pass_reason='chalk_cap'. This proves the new
// reason flows through the passes pile (backing GET /api/passes): it appears in
// the pile, the ?reason=chalk_cap filter isolates it, and it works on BOTH the
// prop and game-line ledgers. Run: tsx server/__tests__/passReasons_chalkCap.test.ts

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graded-chalk-passes-"));
process.env.GRADED_BOOK_PATH = path.join(tmpDir, "test_book.db");
process.env.BANKROLL_USD = "25000";

const { gradedDb, upsertPropPick, upsertPick, passPicks } = await import("../gradedBook");

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

console.log("chalk_cap pass reason — v6.8.1");

// A prop demoted by the chalk cap (would-be SNIPER, but priced -300).
upsertPropPick({
  pick_id: "pChalkProp", sport: "mlb", game_id: "cg1", player_name: "Heavy Chalk",
  market_type: "batter_hits", line: 0.5, side: "over", posted_odds: -300,
  tier: "PASS", pass_reason: "chalk_cap", edge_pp: 9, stake_units: 0,
  posted_at: "2026-06-14T18:00:00Z",
});
// A control prop with a different reason — must not appear under chalk_cap.
upsertPropPick({
  pick_id: "pBelow", sport: "mlb", game_id: "cg2", player_name: "Thin Edge",
  market_type: "batter_hits", line: 1.5, side: "over", posted_odds: -110,
  tier: "PASS", pass_reason: "below_threshold", edge_pp: 2, stake_units: 0,
  posted_at: "2026-06-14T18:00:00Z",
});
// A game-line pick demoted by the chalk cap (priced -400).
const gameChalkId = "cgGame:ML:home";
upsertPick({
  gameId: "cgGame", sport: "mlb", gameDate: "2026-06-14", gameTimeEt: "7:00 PM ET",
  matchup: "X @ Y", homeTeam: "Y", awayTeam: "X", homeTeamFull: "Y Team",
  awayTeamFull: "X Team", pickSide: "home", pickTeam: "Y", pickTeamFull: "Y Team",
  pickType: "ML", pickLine: null, pickMl: -400, pickBook: "dk", gameStartIso: null,
  tier: "PASS", units: 0, stakeDollars: 0, pickWinProb: 0.8, pickImpliedProb: 0.8,
  edgePp: 7, evPer100: 5, confidence: 80, fairMl: -350, pass_reason: "chalk_cap",
});

await test("chalk_cap picks are in the pile (prop + game) and stay tier=PASS", () => {
  const page = passPicks({ type: "ALL" });
  const ids = page.items.map((i) => i.pick_id);
  assert.ok(ids.includes("pChalkProp"), "chalk prop present");
  assert.ok(ids.includes(gameChalkId), "chalk game present");
  assert.ok(page.items.every((i) => i.tier === "PASS"));
});

await test("?reason=chalk_cap isolates ONLY the chalk-capped picks", () => {
  const page = passPicks({ type: "ALL", reason: "chalk_cap" });
  const ids = page.items.map((i) => i.pick_id);
  assert.ok(ids.includes("pChalkProp"), "chalk prop present");
  assert.ok(ids.includes(gameChalkId), "chalk game present");
  assert.ok(!ids.includes("pBelow"), "below_threshold prop excluded");
  assert.ok(page.items.every((i) => i.pass_reason === "chalk_cap"));
});

await test("chalk_cap filter works on the prop ledger alone", () => {
  const page = passPicks({ type: "prop", reason: "chalk_cap" });
  const ids = page.items.map((i) => i.pick_id);
  assert.ok(ids.includes("pChalkProp"));
  assert.ok(!ids.includes(gameChalkId), "game excluded under type=prop");
});

await test("chalk_cap filter works on the game ledger alone", () => {
  const page = passPicks({ type: "game", reason: "chalk_cap" });
  const ids = page.items.map((i) => i.pick_id);
  assert.ok(ids.includes(gameChalkId));
  assert.ok(!ids.includes("pChalkProp"), "prop excluded under type=game");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
