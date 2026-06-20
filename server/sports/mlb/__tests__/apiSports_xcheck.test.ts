// Unit tests for the additive api-sports.io RPG cross-check (v6.12.1). Verifies
// the pure agreement classifier (within 0.30 RPG → 'aligned'; 0.5+ apart →
// 'divergent'; missing api-sports data → 'no-data') and that a pick is still
// produced — tagged 'no-data' — when the feed is unavailable.
// Run: tsx server/sports/mlb/__tests__/apiSports_xcheck.test.ts

import assert from "node:assert/strict";
import { computeXcheckAgreement } from "../data";
import { buildPick, type GameInput } from "../picksEngine";
import { predictGame } from "../model";

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

console.log("api-sports RPG cross-check");

test("within 0.30 RPG on both sides → 'aligned'", () => {
  const x = computeXcheckAgreement(4.6, 4.5, 4.2, 4.4);
  assert.equal(x.agreement, "aligned");
  assert.ok(Math.abs((x.home.deltaVsMlbStats ?? -1) - 0.1) < 1e-9);
  assert.equal(x.home.rpgApiSports, 4.6);
});

test("0.5+ apart on a side → 'divergent'", () => {
  const x = computeXcheckAgreement(5.1, 4.5, 4.4, 4.4);
  assert.equal(x.agreement, "divergent");
});

test("boundary: exactly 0.30 apart → 'aligned' (inclusive)", () => {
  const x = computeXcheckAgreement(4.8, 4.5, 4.5, 4.5);
  assert.equal(x.agreement, "aligned");
});

test("api-sports unavailable on both sides → 'no-data'", () => {
  const x = computeXcheckAgreement(null, 4.5, null, 4.4);
  assert.equal(x.agreement, "no-data");
  assert.equal(x.home.deltaVsMlbStats, null);
});

test("one side has data, the other does not → classifies on the side present", () => {
  const aligned = computeXcheckAgreement(4.6, 4.5, null, 4.4);
  assert.equal(aligned.agreement, "aligned");
  const divergent = computeXcheckAgreement(5.4, 4.5, null, 4.4);
  assert.equal(divergent.agreement, "divergent");
});

test("pipeline still produces a pick (tagged no-data) when api-sports is absent", () => {
  const game: GameInput = {
    gameId: "xcheck-nodata-test",
    gameDate: "2025-07-10",
    gameTimeEt: "7:10 PM ET",
    venue: "Wrigley Field",
    homeTeam: "CHC",
    awayTeam: "COL",
    homeTeamFull: "Chicago Cubs",
    awayTeamFull: "Colorado Rockies",
    mlHome: -150,
    mlAway: 130,
    homeFairProb: 0.6,
    awayFairProb: 0.4,
    homeSpStats: { available: true, pitcher: "P1", era: 4.0, fip: 3.9, ip: 80 },
    awaySpStats: { available: true, pitcher: "P2", era: 4.5, fip: 4.4, ip: 75 },
    homeOffStats: { available: true, ops: 0.74, rpg: 4.6 },
    awayOffStats: { available: true, ops: 0.70, rpg: 4.3 },
    // _apiSportsXcheck intentionally omitted → feed off
  };
  const model = predictGame({
    homeTeam: "CHC",
    awayTeam: "COL",
    homeTeamFull: "Chicago Cubs",
    awayTeamFull: "Colorado Rockies",
    homeSpStats: { available: true, pitcher: "P1", era: 4.0, fip: 3.9, ip: 80 },
    awaySpStats: { available: true, pitcher: "P2", era: 4.5, fip: 4.4, ip: 75 },
    homeOffStats: { ops: 0.74 },
    awayOffStats: { ops: 0.70 },
    venueTriCode: "CHC",
    homeFairProb: 0.6,
    awayFairProb: 0.4,
  });
  const pick = buildPick(game, model);
  assert.ok(pick, "a pick must still be produced when the api-sports feed is off");
  assert.equal(pick.dataFeeds?.apiSportsXcheck, "no-data");
});

test("buildPick surfaces the supplied xcheck agreement", () => {
  const game: GameInput = {
    gameId: "xcheck-aligned-test",
    gameDate: "2025-07-10",
    gameTimeEt: "7:10 PM ET",
    venue: "Wrigley Field",
    homeTeam: "CHC",
    awayTeam: "COL",
    homeTeamFull: "Chicago Cubs",
    awayTeamFull: "Colorado Rockies",
    mlHome: -150,
    mlAway: 130,
    homeFairProb: 0.6,
    awayFairProb: 0.4,
    homeSpStats: { available: true, pitcher: "P1", era: 4.0, fip: 3.9, ip: 80 },
    awaySpStats: { available: true, pitcher: "P2", era: 4.5, fip: 4.4, ip: 75 },
    homeOffStats: { available: true, ops: 0.74, rpg: 4.6 },
    awayOffStats: { available: true, ops: 0.70, rpg: 4.3 },
    _apiSportsXcheck: computeXcheckAgreement(4.6, 4.6, 4.3, 4.3),
  };
  const model = predictGame({
    homeTeam: "CHC",
    awayTeam: "COL",
    homeTeamFull: "Chicago Cubs",
    awayTeamFull: "Colorado Rockies",
    homeSpStats: { available: true, pitcher: "P1", era: 4.0, fip: 3.9, ip: 80 },
    awaySpStats: { available: true, pitcher: "P2", era: 4.5, fip: 4.4, ip: 75 },
    homeOffStats: { ops: 0.74 },
    awayOffStats: { ops: 0.70 },
    venueTriCode: "CHC",
    homeFairProb: 0.6,
    awayFairProb: 0.4,
  });
  const pick = buildPick(game, model);
  assert.equal(pick.dataFeeds?.apiSportsXcheck, "aligned");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
