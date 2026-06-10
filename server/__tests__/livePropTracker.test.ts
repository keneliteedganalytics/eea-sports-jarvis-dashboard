// Tests for the live prop tracker worker (v6.7.3). The load-bearing guarantees:
// a tick writes live_state transitions (and only counts a transition when the
// stored value actually changed), and a pick whose game goes final is graded
// EXACTLY ONCE — a second tick over the same final game must not double-count the
// bankroll (settle is idempotent). Uses injected deps so no live HTTP is needed
// and a temp graded book so bankroll math is observable.
// Run: tsx server/__tests__/livePropTracker.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graded-live-tracker-"));
process.env.GRADED_BOOK_PATH = path.join(tmpDir, "test_book.db");

import type { LiveTrackerDeps } from "../jobs/livePropTracker";

const {
  upsertPropOffer,
  upsertPropPick,
  activePropPicksForDate,
  updatePropPickLiveState,
  settlePropPickWithBankroll,
  getPropPick,
  getBankrollState,
} = await import("../gradedBook");
const { runLiveTrackTick } = await import("../jobs/livePropTracker");

const DATE = "2026-06-10";

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

// Seed a single active prop pick (over 1.5 hits) and its backing offer so the
// activePicks join (by game_date) resolves it for DATE.
function seedPick(): void {
  upsertPropOffer({
    event_id: "evtL", sport: "mlb", game_date: DATE, player_name: "Aaron Judge",
    market: "batter_hits", line: 1.5, over_price: 110, under_price: -130, book: "draftkings",
  });
  upsertPropPick({
    pick_id: "evtL:batter_hits:Aaron Judge:over", sport: "mlb", game_id: "evtL",
    player_name: "Aaron Judge", team: "New York Yankees", opponent: "Boston Red Sox",
    market_type: "batter_hits", line: 1.5, side: "over", posted_odds: 110,
    tier: "EDGE", stake_units: 0.5,
  });
}

console.log("live prop tracker worker");

await test("a clearing live pick writes a live_clear transition", async () => {
  seedPick();
  // Inject a deps object whose schedule resolves the game and feed reports a
  // live boxscore with 1 hit (not yet cleared the 1.5 line → live_clear).
  const deps: LiveTrackerDeps = {
    activePicks: activePropPicksForDate,
    schedule: async () => [{
      gamePk: "G1", startIso: "", homeTeamFull: "New York Yankees", awayTeamFull: "Boston Red Sox",
      homeTeam: "NYY", awayTeam: "BOS", venue: "", homeTeamId: 147, awayTeamId: 111,
      homePitcherId: null, awayPitcherId: null, homePitcher: null, awayPitcher: null,
      homeBattingOrder: [], awayBattingOrder: [],
    }],
    fetchLiveFeed: async () => ({
      gameData: { status: { abstractGameState: "Live" } },
      liveData: { boxscore: { teams: {
        home: { players: { ID592450: { person: { id: 592450, fullName: "Aaron Judge" }, stats: { batting: { hits: 1 } } } } },
        away: { players: {} },
      } } },
    }),
    resolvePlayerId: async () => 592450,
    writeState: updatePropPickLiveState,
    settle: settlePropPickWithBankroll,
  };

  const summary = await runLiveTrackTick(DATE, deps);
  assert.equal(summary.tracked, 1, "one active pick tracked");
  assert.ok(summary.transitions >= 1, "expected a live_clear state write");
  const row = getPropPick("evtL:batter_hits:Aaron Judge:over");
  assert.equal(row?.live_state, "live_clear");
  assert.equal(row?.result ?? null, null, "a live (non-final) pick must not be graded");
});

await test("a final winning game grades exactly once across repeated ticks", async () => {
  const finalDeps: LiveTrackerDeps = {
    activePicks: activePropPicksForDate,
    schedule: async () => [{
      gamePk: "G1", startIso: "", homeTeamFull: "New York Yankees", awayTeamFull: "Boston Red Sox",
      homeTeam: "NYY", awayTeam: "BOS", venue: "", homeTeamId: 147, awayTeamId: 111,
      homePitcherId: null, awayPitcherId: null, homePitcher: null, awayPitcher: null,
      homeBattingOrder: [], awayBattingOrder: [],
    }],
    fetchLiveFeed: async () => ({
      gameData: { status: { abstractGameState: "Final" } },
      liveData: { boxscore: { teams: {
        home: { players: { ID592450: { person: { id: 592450, fullName: "Aaron Judge" }, stats: { batting: { hits: 2 } } } } },
        away: { players: {} },
      } } },
    }),
    resolvePlayerId: async () => 592450,
    writeState: updatePropPickLiveState,
    settle: settlePropPickWithBankroll,
  };

  const before = getBankrollState();
  const first = await runLiveTrackTick(DATE, finalDeps);
  assert.equal(first.graded, 1, "first final tick grades the pick once");

  const afterFirst = getBankrollState();
  assert.notEqual(afterFirst.current, before.current, "bankroll should move on the win");

  const second = await runLiveTrackTick(DATE, finalDeps);
  assert.equal(second.graded, 0, "second tick must not re-grade (idempotent settle)");
  const afterSecond = getBankrollState();
  assert.equal(afterSecond.current, afterFirst.current, "bankroll must not double-count");

  const row = getPropPick("evtL:batter_hits:Aaron Judge:over");
  assert.equal(row?.result, "W", "an over that reached 2 vs a 1.5 line wins");
  assert.equal(row?.live_state, "paid");
});

// v6.7.5 regression: the v6.7.3 false-grade root cause. A pick with team=NULL
// and a STALE opponent ("Boston Red Sox", a DIFFERENT game that is Final) must
// resolve to its own game via the offer's event_home/event_away — not the stale
// opponent's final game — so a scheduled game stays pending and is never graded.
await test("pick with null team + stale opponent resolves its OWN (scheduled) game, not the stale final game", async () => {
  upsertPropOffer({
    event_id: "evtReal", sport: "mlb", game_date: DATE, player_name: "Corey Seager",
    team: null, event_home: "Kansas City Royals", event_away: "Texas Rangers",
    market: "batter_hits", line: 1.5, over_price: 110, under_price: -130, book: "draftkings",
  });
  upsertPropPick({
    pick_id: "evtReal:batter_hits:Corey Seager:under", sport: "mlb", game_id: "evtReal",
    player_name: "Corey Seager", team: null, opponent: "Boston Red Sox",
    market_type: "batter_hits", line: 1.5, side: "under", posted_odds: -130,
    tier: "EDGE", stake_units: 0.5,
  });

  // Schedule has BOTH games: the stale opponent's Red Sox game is FINAL; the
  // pick's real game (Rangers @ Royals) is still scheduled (Preview).
  const schedule = [
    {
      gamePk: "G-redsox-final", startIso: "", homeTeamFull: "Tampa Bay Rays", awayTeamFull: "Boston Red Sox",
      homeTeam: "TB", awayTeam: "BOS", venue: "", homeTeamId: null, awayTeamId: null,
      homePitcherId: null, awayPitcherId: null, homePitcher: null, awayPitcher: null,
      homeBattingOrder: [], awayBattingOrder: [],
    },
    {
      gamePk: "G-rangers-scheduled", startIso: "", homeTeamFull: "Kansas City Royals", awayTeamFull: "Texas Rangers",
      homeTeam: "KC", awayTeam: "TEX", venue: "", homeTeamId: null, awayTeamId: null,
      homePitcherId: null, awayPitcherId: null, homePitcher: null, awayPitcher: null,
      homeBattingOrder: [], awayBattingOrder: [],
    },
  ];
  const deps: LiveTrackerDeps = {
    activePicks: (d) => activePropPicksForDate(d, "mlb").filter((p) => p.pick_id.startsWith("evtReal")),
    schedule: async () => schedule,
    fetchLiveFeed: async (gamePk: string) => {
      // The Red Sox game is Final; the Rangers game is Preview (scheduled).
      const abstractGameState = gamePk === "G-redsox-final" ? "Final" : "Preview";
      return { gameData: { status: { abstractGameState } } } as never;
    },
    resolvePlayerId: async () => null,
    writeState: updatePropPickLiveState,
    settle: settlePropPickWithBankroll,
  };

  const summary = await runLiveTrackTick(DATE, deps);
  assert.equal(summary.graded, 0, "a scheduled game must NOT be graded (the v6.7.3 bug)");
  const row = getPropPick("evtReal:batter_hits:Corey Seager:under");
  assert.equal(row?.result ?? null, null, "pick must remain ungraded — its real game is still scheduled");
  assert.equal(row?.live_state ?? null, "pending", "scheduled game → pending, never paid pre-game");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
