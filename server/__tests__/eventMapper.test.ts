// Unit tests for the Odds-event → MLB gamePk mapper (v6.7.3). The load-bearing
// guarantee: the prior `gamePk === eventId` compare always missed (eventId is an
// Odds API hash), so matchup context fell back to neutral. These verify the
// team-name fuzzy match resolves the real game by exact name, by nickname, and
// returns null when no team matches — plus side + lineup-spot placement.
// Standalone tsx harness using node:assert.
import assert from "node:assert/strict";
import {
  normalizeTeamName,
  teamNamesMatch,
  resolveGamePk,
  findGameForEvent,
  sideOfGame,
  lineupSpotFor,
} from "../sports/props/eventMapper";
import type { ScheduleGame } from "../adapters/mlbStats";

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

function game(over: Partial<ScheduleGame> = {}): ScheduleGame {
  return {
    gamePk: "777001",
    startIso: "2026-06-10T23:05:00Z",
    homeTeamFull: "New York Yankees",
    awayTeamFull: "Boston Red Sox",
    homeTeam: "NYY",
    awayTeam: "BOS",
    venue: "Yankee Stadium",
    homeTeamId: 147,
    awayTeamId: 111,
    homePitcherId: 500,
    awayPitcherId: 600,
    homePitcher: "Home Ace",
    awayPitcher: "Away Ace",
    homeBattingOrder: [],
    awayBattingOrder: [],
    ...over,
  };
}

test("normalizeTeamName lowercases and drops punctuation", () => {
  assert.equal(normalizeTeamName("St. Louis Cardinals"), "st louis cardinals");
});

test("teamNamesMatch: exact normalized match", () => {
  assert.equal(teamNamesMatch("New York Yankees", "new york yankees"), true);
});

test("teamNamesMatch: nickname / containment match", () => {
  assert.equal(teamNamesMatch("Yankees", "New York Yankees"), true);
  assert.equal(teamNamesMatch("NY Yankees", "New York Yankees"), true);
});

test("teamNamesMatch: distinct clubs do not match", () => {
  assert.equal(teamNamesMatch("New York Yankees", "New York Mets"), false);
});

test("teamNamesMatch: null/empty is false", () => {
  assert.equal(teamNamesMatch(null, "Yankees"), false);
  assert.equal(teamNamesMatch("Yankees", undefined), false);
});

test("resolveGamePk: exact home-team match", () => {
  const sched = [game({ gamePk: "G1" }), game({ gamePk: "G2", homeTeamFull: "Chicago Cubs", awayTeamFull: "Milwaukee Brewers" })];
  assert.equal(resolveGamePk({ team: "New York Yankees", opponent: null }, sched), "G1");
});

test("resolveGamePk: fuzzy nickname match on the opponent field", () => {
  const sched = [game({ gamePk: "G2", homeTeamFull: "Chicago Cubs", awayTeamFull: "Milwaukee Brewers" }), game({ gamePk: "G1" })];
  assert.equal(resolveGamePk({ team: null, opponent: "Red Sox" }, sched), "G1");
});

test("resolveGamePk: no team known → null", () => {
  assert.equal(resolveGamePk({ team: null, opponent: null }, [game()]), null);
});

test("resolveGamePk: no scheduled game matches → null", () => {
  const sched = [game({ homeTeamFull: "Chicago Cubs", awayTeamFull: "Milwaukee Brewers" })];
  assert.equal(resolveGamePk({ team: "Los Angeles Dodgers", opponent: "San Diego Padres" }, sched), null);
});

test("resolveGamePk: disambiguates across a multi-game slate", () => {
  const sched = [
    game({ gamePk: "EARLY", homeTeamFull: "Chicago Cubs", awayTeamFull: "Milwaukee Brewers" }),
    game({ gamePk: "LATE", homeTeamFull: "Los Angeles Dodgers", awayTeamFull: "San Francisco Giants" }),
  ];
  assert.equal(resolveGamePk({ team: "Giants", opponent: null }, sched), "LATE");
});

test("findGameForEvent returns the full ScheduleGame", () => {
  const g = findGameForEvent({ team: "Boston Red Sox", opponent: null }, [game()]);
  assert.ok(g);
  assert.equal(g!.venue, "Yankee Stadium");
});

test("sideOfGame places the player's team", () => {
  const g = game();
  assert.equal(sideOfGame("New York Yankees", g), "home");
  assert.equal(sideOfGame("Red Sox", g), "away");
  assert.equal(sideOfGame("Chicago Cubs", g), null);
});

test("lineupSpotFor returns 1-based slot from the posted order", () => {
  const g = game({ homeBattingOrder: [10, 20, 30, 40], awayBattingOrder: [99] });
  assert.equal(lineupSpotFor(30, "home", g), 3);
  assert.equal(lineupSpotFor(99, "away", g), 1);
});

test("lineupSpotFor: unposted / absent player → null", () => {
  const g = game({ homeBattingOrder: [], awayBattingOrder: [] });
  assert.equal(lineupSpotFor(30, "home", g), null);
  assert.equal(lineupSpotFor(null, "home", g), null);
  assert.equal(lineupSpotFor(30, null, g), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
