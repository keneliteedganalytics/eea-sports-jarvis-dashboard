// Virtual parlay builder + DB persistence (v6.8.0). Seeds SNIPER prop picks +
// their offers over a temp graded book, runs the builder, and asserts each
// SNIPER pick auto-forms its OWN $100 single-leg paper bet (no game grouping),
// with the pick's own odds, that non-SNIPER legs are excluded, that the build is
// idempotent (parlay_id = day:pick_id), and that the live tracker settles each
// single as its pick grades WITHOUT moving the bankroll. Run: tsx
// server/__tests__/virtualParlayBuilder.test.ts

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graded-parlay-build-"));
process.env.GRADED_BOOK_PATH = path.join(tmpDir, "test_book.db");

const {
  upsertPropOffer,
  upsertPropPick,
  settlePropPick,
  updatePropPickLiveState,
  getVirtualParlaysForDate,
  getVirtualParlayStats,
  getBankrollState,
} = await import("../gradedBook");
const { americanToDecimal } = await import("../core/odds");
const { buildVirtualParlaysForDates } = await import("../jobs/virtualParlayBuilder");
const { runVirtualParlayTrackForDates } = await import("../jobs/virtualParlayTracker");

const DAY = "2026-06-13";

// Two SNIPER legs + one EDGE leg in game "PITvsMIA"; one SNIPER leg in "NYYvsBOS".
function seedOffer(eventId: string, player: string, home: string, away: string) {
  upsertPropOffer({
    event_id: eventId,
    sport: "mlb",
    game_date: DAY,
    player_name: player,
    market: "batter_hits",
    line: 0.5,
    over_price: -120,
    under_price: 100,
    book: "draftkings",
    event_home: home,
    event_away: away,
  });
}

seedOffer("PITvsMIA", "Bryan Reynolds", "Miami Marlins", "Pittsburgh Pirates");
seedOffer("PITvsMIA", "Ke'Bryan Hayes", "Miami Marlins", "Pittsburgh Pirates");
seedOffer("PITvsMIA", "Andrew McCutchen", "Miami Marlins", "Pittsburgh Pirates");
seedOffer("NYYvsBOS", "Aaron Judge", "Boston Red Sox", "New York Yankees");

const postedAt = `${DAY}T15:00:00.000Z`;
upsertPropPick({ pick_id: "pit1", sport: "mlb", game_id: "PITvsMIA", player_name: "Bryan Reynolds", market_type: "batter_hits", line: 0.5, side: "over", posted_odds: -150, tier: "SNIPER", posted_at: postedAt });
upsertPropPick({ pick_id: "pit2", sport: "mlb", game_id: "PITvsMIA", player_name: "Ke'Bryan Hayes", market_type: "batter_hits", line: 0.5, side: "over", posted_odds: 120, tier: "SNIPER", posted_at: postedAt });
upsertPropPick({ pick_id: "pitEdge", sport: "mlb", game_id: "PITvsMIA", player_name: "Andrew McCutchen", market_type: "batter_hits", line: 0.5, side: "over", posted_odds: -110, tier: "EDGE", posted_at: postedAt });
upsertPropPick({ pick_id: "nyy1", sport: "mlb", game_id: "NYYvsBOS", player_name: "Aaron Judge", market_type: "batter_hits", line: 0.5, side: "over", posted_odds: -200, tier: "SNIPER", posted_at: postedAt });

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

console.log("virtual parlay builder — v6.8.0 (per-pick singles)");

const startingBankroll = getBankrollState().current;

buildVirtualParlaysForDates([DAY]);
const parlays = getVirtualParlaysForDate(DAY);

test("one single per SNIPER pick (EDGE excluded) — 3 SNIPER, 0 from EDGE", () => {
  assert.equal(parlays.length, 3);
});

test("each single carries exactly one leg = its own pick", () => {
  for (const p of parlays) {
    assert.equal(p.leg_count, 1);
    const ids = JSON.parse(p.leg_pick_ids) as string[];
    assert.equal(ids.length, 1);
  }
  const allIds = parlays.flatMap((p) => JSON.parse(p.leg_pick_ids) as string[]).sort();
  assert.deepEqual(allIds, ["nyy1", "pit1", "pit2"]);
  assert.ok(!allIds.includes("pitEdge"));
});

test("parlay_id is <day>:<pick_id> and stake is $100", () => {
  const pit1 = parlays.find((p) => p.parlay_id === `${DAY}:pit1`)!;
  assert.ok(pit1, "pit1 single missing");
  assert.equal(pit1.stake_dollars, 100);
  assert.equal(pit1.game_id, "PITvsMIA");
});

test("a single's odds ARE the pick's odds; payout/profit follow", () => {
  const pit1 = parlays.find((p) => p.parlay_id === `${DAY}:pit1`)!;
  const expectedDec = americanToDecimal(-150)!;
  assert.ok(Math.abs(pit1.combined_decimal! - expectedDec) < 1e-4);
  assert.equal(pit1.combined_american, -150);
  assert.ok(Math.abs(pit1.potential_payout_dollars! - 100 * expectedDec) < 0.01);
  assert.ok(Math.abs(pit1.potential_profit_dollars! - (100 * expectedDec - 100)) < 0.01);
});

test("game label is away @ home from the offer event teams", () => {
  const pit1 = parlays.find((p) => p.parlay_id === `${DAY}:pit1`)!;
  assert.equal(pit1.game_label, "Pittsburgh Pirates @ Miami Marlins");
});

test("fresh singles start pending with their one leg pending", () => {
  const pit1 = parlays.find((p) => p.parlay_id === `${DAY}:pit1`)!;
  assert.equal(pit1.status, "pending");
  assert.equal(pit1.legs_pending, 1);
  assert.equal(pit1.pl_dollars, null);
});

test("re-running the builder is idempotent (no duplicate rows)", () => {
  buildVirtualParlaysForDates([DAY]);
  assert.equal(getVirtualParlaysForDate(DAY).length, 3);
});

// --- live tracking transitions ---

test("a pick clearing live (ungraded) keeps its single pending — only a graded W moves it", () => {
  updatePropPickLiveState("pit1", "live_clear", 1, "live");
  runVirtualParlayTrackForDates([DAY]);
  const pit1 = getVirtualParlaysForDate(DAY).find((p) => p.parlay_id === `${DAY}:pit1`)!;
  // live_clear is not yet a win; a single only settles when its one leg grades.
  assert.equal(pit1.status, "pending");
});

test("a graded WIN settles the single as WON with profit, bankroll UNCHANGED", () => {
  settlePropPick("pit1", { result: "W", actualValue: 2, plUnits: 0, plDollars: 0 });
  runVirtualParlayTrackForDates([DAY]);
  const pit1 = getVirtualParlaysForDate(DAY).find((p) => p.parlay_id === `${DAY}:pit1`)!;
  assert.equal(pit1.status, "won");
  assert.equal(pit1.legs_won, 1);
  assert.ok((pit1.pl_dollars ?? 0) > 0);
  assert.ok(pit1.graded_at != null);
  // The whole point: a paper bet NEVER moves the real bankroll.
  assert.equal(getBankrollState().current, startingBankroll);
});

test("a busted pick busts its single for −$100, bankroll still unchanged", () => {
  settlePropPick("nyy1", { result: "L", actualValue: 0, plUnits: 0, plDollars: 0 });
  runVirtualParlayTrackForDates([DAY]);
  const nyy = getVirtualParlaysForDate(DAY).find((p) => p.parlay_id === `${DAY}:nyy1`)!;
  assert.equal(nyy.status, "busted");
  assert.equal(nyy.pl_dollars, -100);
  assert.equal(getBankrollState().current, startingBankroll);
});

test("aggregate stats: 1 won + 1 busted settled across singles", () => {
  const stats = getVirtualParlayStats();
  assert.equal(stats.won, 1);
  assert.equal(stats.busted, 1);
  // pit1 won + nyy1 busted = $200 staked across settled singles.
  assert.equal(stats.total_staked, 200);
  assert.equal(stats.win_rate_pct, 50);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
