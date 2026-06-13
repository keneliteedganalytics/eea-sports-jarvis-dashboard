// Virtual parlay builder + DB persistence (v6.7.9). Seeds SNIPER prop picks +
// their offers over a temp graded book, runs the builder, and asserts each game
// group auto-forms a $100 parlay with correct combined odds, that non-SNIPER
// legs are excluded, that the build is idempotent (parlay_id = day:game_id), and
// that the live tracker advances the parlay as legs settle WITHOUT moving the
// bankroll. Run: tsx server/__tests__/virtualParlayBuilder.test.ts

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
const { americanToDecimal, decimalToAmerican } = await import("../core/odds");
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

console.log("virtual parlay builder — v6.7.9");

const startingBankroll = getBankrollState().current;

buildVirtualParlaysForDates([DAY]);
const parlays = getVirtualParlaysForDate(DAY);

test("one parlay per game group with >=1 SNIPER pick", () => {
  assert.equal(parlays.length, 2);
});

test("the Pirates@Marlins parlay uses ONLY its two SNIPER legs (EDGE excluded)", () => {
  const pit = parlays.find((p) => p.game_id === "PITvsMIA")!;
  assert.ok(pit, "PIT parlay missing");
  assert.equal(pit.leg_count, 2);
  const ids = JSON.parse(pit.leg_pick_ids) as string[];
  assert.deepEqual(ids.sort(), ["pit1", "pit2"]);
  assert.ok(!ids.includes("pitEdge"));
});

test("parlay_id is <day>:<game_id> and stake is $100", () => {
  const pit = parlays.find((p) => p.game_id === "PITvsMIA")!;
  assert.equal(pit.parlay_id, `${DAY}:PITvsMIA`);
  assert.equal(pit.stake_dollars, 100);
});

test("combined odds = product of leg decimals; payout/profit follow", () => {
  const pit = parlays.find((p) => p.game_id === "PITvsMIA")!;
  const expectedDec = americanToDecimal(-150)! * americanToDecimal(120)!;
  assert.ok(Math.abs(pit.combined_decimal! - expectedDec) < 1e-4);
  assert.equal(pit.combined_american, decimalToAmerican(expectedDec));
  assert.ok(Math.abs(pit.potential_payout_dollars! - 100 * expectedDec) < 0.01);
  assert.ok(Math.abs(pit.potential_profit_dollars! - (100 * expectedDec - 100)) < 0.01);
});

test("game label is away @ home from the offer event teams", () => {
  const pit = parlays.find((p) => p.game_id === "PITvsMIA")!;
  assert.equal(pit.game_label, "Pittsburgh Pirates @ Miami Marlins");
});

test("fresh parlays start pending with all legs pending", () => {
  const pit = parlays.find((p) => p.game_id === "PITvsMIA")!;
  assert.equal(pit.status, "pending");
  assert.equal(pit.legs_pending, 2);
  assert.equal(pit.pl_dollars, null);
});

test("re-running the builder is idempotent (no duplicate rows)", () => {
  buildVirtualParlaysForDates([DAY]);
  assert.equal(getVirtualParlaysForDate(DAY).length, 2);
});

// --- live tracking transitions ---

test("one SNIPER leg clearing live → parlay goes LIVE (pl still null)", () => {
  updatePropPickLiveState("pit1", "live_clear", 1, "live");
  runVirtualParlayTrackForDates([DAY]);
  const pit = getVirtualParlaysForDate(DAY).find((p) => p.game_id === "PITvsMIA")!;
  // live_clear is not yet a win, so still pending until a leg grades W.
  assert.equal(pit.status, "pending");
});

test("a graded WIN on one leg moves the parlay to LIVE", () => {
  settlePropPick("pit1", { result: "W", actualValue: 2, plUnits: 0, plDollars: 0 });
  runVirtualParlayTrackForDates([DAY]);
  const pit = getVirtualParlaysForDate(DAY).find((p) => p.game_id === "PITvsMIA")!;
  assert.equal(pit.status, "live");
  assert.equal(pit.legs_won, 1);
  assert.equal(pit.pl_dollars, null);
});

test("all legs won → parlay WON with profit, bankroll UNCHANGED", () => {
  settlePropPick("pit2", { result: "W", actualValue: 1, plUnits: 0, plDollars: 0 });
  runVirtualParlayTrackForDates([DAY]);
  const pit = getVirtualParlaysForDate(DAY).find((p) => p.game_id === "PITvsMIA")!;
  assert.equal(pit.status, "won");
  assert.ok((pit.pl_dollars ?? 0) > 0);
  assert.ok(pit.graded_at != null);
  // The whole point: a paper parlay NEVER moves the real bankroll.
  assert.equal(getBankrollState().current, startingBankroll);
});

test("a busted leg busts the NYY parlay for −$100, bankroll still unchanged", () => {
  settlePropPick("nyy1", { result: "L", actualValue: 0, plUnits: 0, plDollars: 0 });
  runVirtualParlayTrackForDates([DAY]);
  const nyy = getVirtualParlaysForDate(DAY).find((p) => p.game_id === "NYYvsBOS")!;
  assert.equal(nyy.status, "busted");
  assert.equal(nyy.pl_dollars, -100);
  assert.equal(getBankrollState().current, startingBankroll);
});

test("aggregate stats: 1 won + 1 busted settled, paper P/L = profit − 100", () => {
  const stats = getVirtualParlayStats();
  assert.equal(stats.won, 1);
  assert.equal(stats.busted, 1);
  assert.equal(stats.total_staked, 200);
  assert.equal(stats.win_rate_pct, 50);
  const pit = getVirtualParlaysForDate(DAY).find((p) => p.game_id === "PITvsMIA")!;
  const expectedPl = Math.round(((pit.pl_dollars ?? 0) - 100) * 100) / 100;
  assert.ok(Math.abs(stats.total_pl_dollars - expectedPl) < 0.01);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
