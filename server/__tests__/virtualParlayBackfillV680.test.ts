// Backfill v6.8.0 (boot one-shot). Seeds a pre-existing v6.7.9-style per-game
// grouping row directly, then runs backfillVirtualParlaysV680 and asserts it:
//   (1) WIPES the prior grouping for the window,
//   (2) rebuilds each SNIPER pick as its own $100 single (leg_count=1),
//   (3) is idempotent via the parlay_backfill_v6_8_0 system_state flag (a second
//       call is a no-op), and never moves the bankroll.
// Run: tsx server/__tests__/virtualParlayBackfillV680.test.ts

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graded-parlay-backfill-"));
process.env.GRADED_BOOK_PATH = path.join(tmpDir, "test_book.db");

const {
  upsertPropOffer,
  upsertPropPick,
  upsertVirtualParlay,
  getVirtualParlaysForDate,
  getSystemState,
  getBankrollState,
} = await import("../gradedBook");
const { backfillVirtualParlaysV680 } = await import("../jobs/virtualParlayBuilder");
const { getOperatingDay } = await import("../sports/mlb/operatingDay");

const DAY = getOperatingDay();
const postedAt = `${DAY}T15:00:00.000Z`;

upsertPropOffer({
  event_id: "PITvsMIA", sport: "mlb", game_date: DAY, player_name: "Bryan Reynolds",
  market: "batter_hits", line: 0.5, over_price: -120, under_price: 100, book: "draftkings",
  event_home: "Miami Marlins", event_away: "Pittsburgh Pirates",
});
upsertPropOffer({
  event_id: "PITvsMIA", sport: "mlb", game_date: DAY, player_name: "Ke'Bryan Hayes",
  market: "batter_hits", line: 0.5, over_price: -120, under_price: 100, book: "draftkings",
  event_home: "Miami Marlins", event_away: "Pittsburgh Pirates",
});
upsertPropPick({ pick_id: "pit1", sport: "mlb", game_id: "PITvsMIA", player_name: "Bryan Reynolds", market_type: "batter_hits", line: 0.5, side: "over", posted_odds: -150, tier: "SNIPER", posted_at: postedAt });
upsertPropPick({ pick_id: "pit2", sport: "mlb", game_id: "PITvsMIA", player_name: "Ke'Bryan Hayes", market_type: "batter_hits", line: 0.5, side: "over", posted_odds: 120, tier: "SNIPER", posted_at: postedAt });

// Seed a stale v6.7.9-style per-game grouping (one row, both legs combined).
upsertVirtualParlay({
  parlay_id: `${DAY}:PITvsMIA`,
  operating_day: DAY,
  game_id: "PITvsMIA",
  game_label: "Pittsburgh Pirates @ Miami Marlins",
  sport: "mlb",
  leg_count: 2,
  leg_pick_ids: ["pit1", "pit2"],
  combined_decimal: 3.0,
  combined_american: 200,
  potential_payout_dollars: 300,
  potential_profit_dollars: 200,
});

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

console.log("virtual parlay backfill — v6.8.0");

const startingBankroll = getBankrollState().current;

test("prior per-game grouping exists before backfill", () => {
  const before = getVirtualParlaysForDate(DAY);
  assert.equal(before.length, 1);
  assert.equal(before[0].leg_count, 2);
});

const result = backfillVirtualParlaysV680();

test("backfill ran and wiped the prior grouping", () => {
  assert.equal(result.ran, true);
  assert.ok((result.wiped ?? 0) >= 1);
});

test("window rebuilt as per-pick singles (2 picks → 2 rows, leg_count=1)", () => {
  const after = getVirtualParlaysForDate(DAY);
  assert.equal(after.length, 2);
  for (const p of after) {
    assert.equal(p.leg_count, 1);
    assert.equal(p.stake_dollars, 100);
  }
  const ids = after.map((p) => p.parlay_id).sort();
  assert.deepEqual(ids, [`${DAY}:pit1`, `${DAY}:pit2`]);
});

test("idempotency flag is set after the run", () => {
  assert.ok(getSystemState("parlay_backfill_v6_8_0"));
});

test("a second backfill is a no-op (flag-guarded)", () => {
  const second = backfillVirtualParlaysV680();
  assert.equal(second.ran, false);
  assert.equal(getVirtualParlaysForDate(DAY).length, 2);
});

test("backfill never moved the bankroll", () => {
  assert.equal(getBankrollState().current, startingBankroll);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
