// End-to-end integration for the v6.7.2 fix: prove that with a player-id resolver
// in the chain, a seeded offer flows resolve-id → persist-id → fetch-profile →
// simulate → edge → gate → write and produces at least one prop pick. This is the
// regression guard for the root-cause bug (offers had player_id=null, so every
// profile fetch short-circuited and written was 0 across thousands of offers).
//
// We seed a real offer into a temp graded book, inject mock deps (a resolver that
// returns a numeric id, a batter profile that yields a strong over edge against a
// 0.5 hits line at +110), and let the REAL simulator + edge + gating run.
// Run: tsx server/__tests__/buildPropPicksIntegration.test.ts

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graded-prop-build-"));
process.env.GRADED_BOOK_PATH = path.join(tmpDir, "test_book.db");

import type { BuildDeps } from "../sports/props/buildPropPicks";
import type { BatterProfile, BatterGameLog } from "../sports/props/mlbStatsProps";

const { upsertPropOffer, propOffersForDate, setPropOfferPlayerId } = await import("../gradedBook");
const { buildMlbPropPicks } = await import("../sports/props/buildPropPicks");

const DATE = "2026-06-10";

// A solid contact hitter (~1.3 hits/game, season anchor present): the simulated
// median sits well above a 0.5 hits line, so the model strongly favors the over.
function batterLog(over: Partial<BatterGameLog> = {}): BatterGameLog {
  return {
    date: "2026-06-01", pa: 4, ab: 4, hits: 1, totalBases: 2, homeRuns: 0,
    runs: 1, rbi: 1, walks: 0, singles: 1, oppPitcherHand: "R", home: true, ...over,
  };
}
function strongBatter(id: number): BatterProfile {
  return {
    available: true,
    playerId: id,
    name: "Aaron Judge",
    logs: Array.from({ length: 20 }, (_, i) => batterLog({ hits: i % 3 === 0 ? 2 : 1, home: i % 2 === 0 })),
    seasonPa: 500,
    seasonRates: {
      hitsPerPa: 0.3, tbPerPa: 0.5, hrPerPa: 0.04, runsPerPa: 0.15,
      rbiPerPa: 0.14, walksPerPa: 0.09, singlesPerPa: 0.2,
    },
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

console.log("build prop picks — end-to-end with id resolver");

await test("resolver + profile in the chain writes ≥1 pick from a clearing offer", async () => {
  // Seed one offer (player_id null, as the Odds API delivers it) on two books so
  // the line-shopping quote set is non-trivial. Over priced at −200 / −195: a
  // genuine but moderate edge (≈13pp) that clears the gate without tripping the
  // v6.7.3 model-outlier filter (which rejects edges > 20pp whose median sits
  // > 0.5σ from the line — see propModelOutlier.test.ts).
  upsertPropOffer({
    event_id: "evtA", sport: "mlb", game_date: DATE, player_name: "Aaron Judge",
    market: "batter_hits", line: 0.5, over_price: -200, under_price: 170, book: "draftkings",
  });
  upsertPropOffer({
    event_id: "evtA", sport: "mlb", game_date: DATE, player_name: "Aaron Judge",
    market: "batter_hits", line: 0.5, over_price: -195, under_price: 165, book: "fanduel",
  });

  let resolveCalls = 0;
  let persisted: { eventId: string; market: string; player: string; id: number } | null = null;
  const deps: BuildDeps = {
    resolveId: async (name: string) => { resolveCalls++; return name === "Aaron Judge" ? 592450 : null; },
    persistId: (eventId, market, player, id) => { persisted = { eventId, market, player, id }; },
    batterProfile: async (playerId) => {
      assert.equal(playerId, 592450, "builder must pass the resolved id, not null");
      return strongBatter(playerId as number);
    },
    pitcherProfile: async () => ({ available: false, playerId: null, name: "", logs: [], starts: 0, seasonRates: null }),
    schedule: async () => [],
  };

  const summary = await buildMlbPropPicks(DATE, deps);

  assert.equal(resolveCalls, 1, "resolver should be called once for the one grouped offer");
  assert.ok(persisted, "resolved id should be persisted back to the offer");
  assert.equal(persisted!.id, 592450);
  assert.ok(summary.written >= 1, `expected ≥1 pick written, got ${summary.written}`);
  assert.ok(summary.pickIds.length >= 1);
});

await test("a cached offer player_id skips re-resolution", async () => {
  // The previous test persisted id back via the mock (which only set an in-memory
  // var, not the DB). Re-stub persistId to write the DB, then run again and assert
  // the resolver is NOT called because the id now rides on the offer rows.
  const offers = propOffersForDate(DATE, "mlb");
  // Simulate a prior cycle having persisted the id by writing it directly.
  setPropOfferPlayerId("evtA", "batter_hits", "Aaron Judge", 592450);
  assert.ok(offers.length >= 1);

  let resolveCalls = 0;
  const deps: BuildDeps = {
    resolveId: async () => { resolveCalls++; return 592450; },
    persistId: () => undefined,
    batterProfile: async (playerId) => {
      assert.equal(playerId, 592450, "cached id should flow through grouping");
      return strongBatter(592450);
    },
    pitcherProfile: async () => ({ available: false, playerId: null, name: "", logs: [], starts: 0, seasonRates: null }),
    schedule: async () => [],
  };

  const summary = await buildMlbPropPicks(DATE, deps);
  assert.equal(resolveCalls, 0, "resolver must be skipped when the offer already carries an id");
  assert.ok(summary.written >= 1, `expected ≥1 pick written from the cached id, got ${summary.written}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
