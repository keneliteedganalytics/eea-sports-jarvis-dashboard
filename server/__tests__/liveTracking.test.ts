// Unit tests for live in-game prop tracking (v6.7.3). Covers the pure state
// machine (computeLiveState over+under × clear/bust/paid × in-progress/final),
// the market→stat mapper including derived singles and pitcher-outs IP parsing
// ("5.2"→17, "0.0"→0, "9.0"→27), and the end-to-end computeLiveTracking pass with
// injected feed/schedule deps (no live HTTP). Standalone tsx harness.
import assert from "node:assert/strict";
import {
  computeLiveState,
  statForMarket,
  computeLiveTracking,
  type TrackedProp,
} from "../sports/props/liveTracking";
import type { ScheduleGame } from "../adapters/mlbStats";

let passed = 0;
let failed = 0;
const queue: Array<() => Promise<void>> = [];
function test(name: string, fn: () => void | Promise<void>) {
  queue.push(async () => {
    try {
      await fn();
      passed++;
      console.log(`  ok   ${name}`);
    } catch (err) {
      failed++;
      console.error(`  FAIL ${name}`);
      console.error(`       ${(err as Error).message}`);
    }
  });
}

// ── computeLiveState matrix ──────────────────────────────────────────────────

test("over, in progress: clears to paid once it reaches ceil(line)", () => {
  assert.equal(computeLiveState({ side: "over", line: 1.5 }, 1, false), "live_clear");
  assert.equal(computeLiveState({ side: "over", line: 1.5 }, 2, false), "paid");
});

test("under, in progress: busts the moment it exceeds floor(line)", () => {
  assert.equal(computeLiveState({ side: "under", line: 1.5 }, 1, false), "live_clear");
  assert.equal(computeLiveState({ side: "under", line: 1.5 }, 2, false), "busted");
});

test("over, final: paid iff value reached ceil(line)", () => {
  assert.equal(computeLiveState({ side: "over", line: 1.5 }, 2, true), "paid");
  assert.equal(computeLiveState({ side: "over", line: 1.5 }, 1, true), "busted");
});

test("under, final: paid iff value stayed at/below floor(line)", () => {
  assert.equal(computeLiveState({ side: "under", line: 1.5 }, 1, true), "paid");
  assert.equal(computeLiveState({ side: "under", line: 1.5 }, 2, true), "busted");
});

test("integer line over: needs to clear the whole number", () => {
  // line 2.0 → ceil 2; value 2 clears.
  assert.equal(computeLiveState({ side: "over", line: 2 }, 2, false), "paid");
  assert.equal(computeLiveState({ side: "over", line: 2 }, 1, false), "live_clear");
});

// ── statForMarket ────────────────────────────────────────────────────────────

test("statForMarket: batter hits / total bases", () => {
  const b = { batting: { hits: 2, totalBases: 5 } };
  assert.equal(statForMarket("batter_hits", b), 2);
  assert.equal(statForMarket("batter_total_bases", b), 5);
});

test("statForMarket: singles derived (hits − 2B − 3B − HR)", () => {
  const b = { batting: { hits: 4, doubles: 1, triples: 0, homeRuns: 1 } };
  assert.equal(statForMarket("batter_singles", b), 2);
});

test("statForMarket: pitcher_outs parses inningsPitched", () => {
  assert.equal(statForMarket("pitcher_outs", { pitching: { inningsPitched: "5.2" } }), 17);
  assert.equal(statForMarket("pitcher_outs", { pitching: { inningsPitched: "0.0" } }), 0);
  assert.equal(statForMarket("pitcher_outs", { pitching: { inningsPitched: "9.0" } }), 27);
});

test("statForMarket: missing stat group → null", () => {
  assert.equal(statForMarket("batter_hits", { pitching: {} }), null);
  assert.equal(statForMarket("pitcher_strikeouts", { batting: {} }), null);
  assert.equal(statForMarket("batter_hits", undefined), null);
});

// ── computeLiveTracking end-to-end (injected deps) ───────────────────────────

function game(over: Partial<ScheduleGame> = {}): ScheduleGame {
  return {
    gamePk: "G1", startIso: "2026-06-10T23:05:00Z",
    homeTeamFull: "New York Yankees", awayTeamFull: "Boston Red Sox",
    homeTeam: "NYY", awayTeam: "BOS", venue: "Yankee Stadium",
    homeTeamId: 147, awayTeamId: 111, homePitcherId: 500, awayPitcherId: 600,
    homePitcher: "H", awayPitcher: "A", homeBattingOrder: [], awayBattingOrder: [],
    ...over,
  };
}

const pick: TrackedProp = {
  pick_id: "p1", game_id: "evt-hash", player_name: "Aaron Judge",
  market_type: "batter_hits", line: 1.5, side: "over",
  team: "New York Yankees", opponent: "Boston Red Sox", player_id: 592450,
};

test("computeLiveTracking: unresolved game stays pending", async () => {
  const out = await computeLiveTracking([pick], {
    fetchLiveFeed: async () => null,
    resolvePlayerId: async () => null,
    schedule: [], // no game → pending
  });
  assert.equal(out.p1.liveState, "pending");
  assert.equal(out.p1.gameStatus, "scheduled");
});

test("computeLiveTracking: live feed marks an over paid when it clears", async () => {
  const feed = {
    gameData: { status: { abstractGameState: "Live" } },
    liveData: { boxscore: { teams: { home: { players: { ID592450: { person: { id: 592450, fullName: "Aaron Judge" }, stats: { batting: { hits: 2 } } } } }, away: { players: {} } } } },
  };
  const out = await computeLiveTracking([pick], {
    fetchLiveFeed: async () => feed,
    resolvePlayerId: async () => 592450,
    schedule: [game()],
  });
  assert.equal(out.p1.gameStatus, "live");
  assert.equal(out.p1.currentValue, 2);
  assert.equal(out.p1.liveState, "paid");
});

test("computeLiveTracking: final game with under that held is paid", async () => {
  const underPick: TrackedProp = { ...pick, pick_id: "p2", side: "under" };
  const feed = {
    gameData: { status: { abstractGameState: "Final" } },
    liveData: { boxscore: { teams: { home: { players: { ID592450: { person: { id: 592450 }, stats: { batting: { hits: 1 } } } } }, away: { players: {} } } } },
  };
  const out = await computeLiveTracking([underPick], {
    fetchLiveFeed: async () => feed,
    resolvePlayerId: async () => 592450,
    schedule: [game()],
  });
  assert.equal(out.p2.gameStatus, "final");
  assert.equal(out.p2.liveState, "paid");
});

(async () => {
  for (const t of queue) await t();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
