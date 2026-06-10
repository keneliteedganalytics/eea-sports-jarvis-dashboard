// Integration for the v6.7.3 matchup-join fix (#8) + lineup-spot resolution (#9).
// The prior `gamePk === eventId` compare never matched (eventId is an Odds API
// hash), so every pick fell back to neutral context. Here we seed an offer whose
// event_home/event_away name a scheduled game with a posted batting order that
// contains the resolved player id; the builder must locate the game by team and
// place the player at his posted lineup slot. We assert the pick writes (proving
// the join now matches) and exercise lineupSpotFor on the same fixture.
// Run: tsx server/__tests__/propLineupSpot.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graded-lineup-spot-"));
process.env.GRADED_BOOK_PATH = path.join(tmpDir, "test_book.db");

import type { BuildDeps } from "../sports/props/buildPropPicks";
import type { BatterProfile, BatterGameLog } from "../sports/props/mlbStatsProps";
import type { ScheduleGame } from "../adapters/mlbStats";

const { upsertPropOffer } = await import("../gradedBook");
const { buildMlbPropPicks } = await import("../sports/props/buildPropPicks");
const { lineupSpotFor, findGameForEvent } = await import("../sports/props/eventMapper");

const DATE = "2026-06-10";
const PLAYER_ID = 592450;

function batterLog(over: Partial<BatterGameLog> = {}): BatterGameLog {
  return {
    date: "2026-06-01", pa: 4, ab: 4, hits: 1, totalBases: 2, homeRuns: 0,
    runs: 1, rbi: 1, walks: 0, singles: 1, oppPitcherHand: "R", home: true, ...over,
  };
}
function strongBatter(): BatterProfile {
  return {
    available: true, playerId: PLAYER_ID, name: "Aaron Judge",
    logs: Array.from({ length: 20 }, (_, i) => batterLog({ hits: i % 3 === 0 ? 2 : 1 })),
    seasonPa: 500,
    seasonRates: {
      hitsPerPa: 0.3, tbPerPa: 0.5, hrPerPa: 0.04, runsPerPa: 0.15,
      rbiPerPa: 0.14, walksPerPa: 0.09, singlesPerPa: 0.2,
    },
  };
}

function scheduledGame(): ScheduleGame {
  return {
    gamePk: "G1", startIso: "2026-06-10T23:05:00Z",
    homeTeamFull: "New York Yankees", awayTeamFull: "Boston Red Sox",
    homeTeam: "NYY", awayTeam: "BOS", venue: "Yankee Stadium",
    homeTeamId: 147, awayTeamId: 111, homePitcherId: 700, awayPitcherId: 800,
    homePitcher: "Home SP", awayPitcher: "Away SP",
    homeBattingOrder: [1, 2, PLAYER_ID, 4, 5, 6, 7, 8, 9], // Judge bats 3rd
    awayBattingOrder: [],
  };
}

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>) {
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

console.log("matchup join + lineup-spot resolution");

await test("lineupSpotFor reads the posted slot for the resolved id", () => {
  const g = scheduledGame();
  const home = findGameForEvent({ team: "New York Yankees", opponent: "Boston Red Sox" }, [g]);
  assert.ok(home, "event teams should resolve a scheduled game");
  assert.equal(lineupSpotFor(PLAYER_ID, "home", home!), 3, "Judge bats 3rd");
  return Promise.resolve();
});

await test("builder locates the game by event teams and writes a pick", async () => {
  // Offer carries event_home/event_away (as the ingester now stores them). The
  // builder must match those to the scheduled game (not the hash eventId).
  upsertPropOffer({
    event_id: "evt-hash-not-a-gamePk", sport: "mlb", game_date: DATE,
    player_name: "Aaron Judge", market: "batter_hits", line: 0.5,
    over_price: 110, under_price: -130, book: "draftkings",
    event_home: "New York Yankees", event_away: "Boston Red Sox",
  });

  const deps: BuildDeps = {
    resolveId: async () => PLAYER_ID,
    persistId: () => undefined,
    batterProfile: async () => strongBatter(),
    pitcherProfile: async () => ({ available: false, playerId: null, name: "", logs: [], starts: 0, seasonRates: null }),
    schedule: async () => [scheduledGame()],
  };

  const summary = await buildMlbPropPicks(DATE, deps);
  assert.ok(summary.written >= 1, `expected the join to resolve and write a pick, got ${summary.written}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
