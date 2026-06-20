// Unit tests for the api-sports.io baseball adapter (v6.12.1). Verifies the
// feature-flag short-circuit (no key → zero HTTP calls), 200 parsing of team
// statistics, graceful {available:false} on 429/500, and no-throw on malformed
// JSON. getJson hits the global fetch, so we stub globalThis.fetch and count
// calls. Each case uses distinct params so the 10-min in-process cache never
// masks a fresh call.
// Run: tsx server/adapters/__tests__/apiSports.test.ts

import assert from "node:assert/strict";

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

const realFetch = globalThis.fetch;
function stubFetch(body: unknown, status = 200): () => number {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return {
      status,
      headers: { forEach: () => undefined },
      json: async () => body,
    } as unknown as Response;
  }) as typeof fetch;
  return () => calls;
}
function stubFetchThrowingJson(): () => number {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return {
      status: 200,
      headers: { forEach: () => undefined },
      json: async () => {
        throw new Error("malformed JSON");
      },
    } as unknown as Response;
  }) as typeof fetch;
  return () => calls;
}
function restoreFetch() {
  globalThis.fetch = realFetch;
}

const {
  hasApiSportsKey,
  fetchTeamStatistics,
  fetchGamesByDate,
  fetchStandings,
  fetchOddsForGame,
} = await import("../apiSports");

console.log("api-sports baseball adapter");

await test("no key → every function returns {available:false} with ZERO HTTP calls", async () => {
  delete process.env.API_SPORTS_KEY;
  assert.equal(hasApiSportsKey(), false);
  const count = stubFetch({ response: [] });

  const stats = await fetchTeamStatistics(99, 2025);
  const games = await fetchGamesByDate("2025-07-10");
  const standings = await fetchStandings(1, 2025);
  const odds = await fetchOddsForGame(123);
  restoreFetch();

  assert.equal(stats.available, false, "team stats unavailable without key");
  assert.equal(games.available, false, "games unavailable without key");
  assert.equal(standings.available, false, "standings unavailable without key");
  assert.equal(odds.available, false, "odds unavailable without key");
  assert.equal(count(), 0, "no HTTP call may be made when the key is absent");
});

await test("key + 200 parses team statistics (rpg)", async () => {
  process.env.API_SPORTS_KEY = "test-key";
  stubFetch({
    response: { games: { played: { all: 50 } }, runs: { for: { average: { all: "4.7" } } } },
  });
  // unique team id so the cache doesn't collide with other cases
  const stats = await fetchTeamStatistics(101, 2099);
  restoreFetch();
  assert.equal(stats.available, true);
  assert.equal(stats.rpg, 4.7);
  assert.equal(stats.gamesPlayed, 50);
  assert.equal(stats.opsLike, null, "no true OPS on this plan → null proxy");
});

await test("key + 200 also reads 'points' average when 'runs' is absent", async () => {
  process.env.API_SPORTS_KEY = "test-key";
  stubFetch({ response: { points: { for: { average: { all: 5.1 } } } } });
  const stats = await fetchTeamStatistics(102, 2099);
  restoreFetch();
  assert.equal(stats.available, true);
  assert.equal(stats.rpg, 5.1);
});

await test("key + 429 → {available:false} gracefully (no throw)", async () => {
  process.env.API_SPORTS_KEY = "test-key";
  stubFetch({ message: "rate limited" }, 429);
  const stats = await fetchTeamStatistics(103, 2099);
  restoreFetch();
  assert.equal(stats.available, false);
});

await test("key + 500 → {available:false} gracefully (no throw)", async () => {
  process.env.API_SPORTS_KEY = "test-key";
  stubFetch({ message: "server error" }, 500);
  const games = await fetchGamesByDate("2099-01-02");
  restoreFetch();
  assert.equal(games.available, false);
  assert.deepEqual(games.games, []);
});

await test("key + malformed JSON → {available:false}, never throws", async () => {
  process.env.API_SPORTS_KEY = "test-key";
  stubFetchThrowingJson();
  let threw = false;
  let stats;
  try {
    stats = await fetchTeamStatistics(104, 2099);
  } catch {
    threw = true;
  }
  restoreFetch();
  assert.equal(threw, false, "adapter must not throw on malformed JSON");
  assert.equal(stats?.available, false);
});

await test("key + 200 parses games-by-date schedule", async () => {
  process.env.API_SPORTS_KEY = "test-key";
  stubFetch({
    response: [
      {
        id: 7001,
        date: "2099-04-01T00:00:00Z",
        status: { short: "NS" },
        teams: { home: { id: 1, name: "Home FC" }, away: { id: 2, name: "Away FC" } },
        scores: { home: { total: null }, away: { total: null } },
      },
    ],
  });
  const games = await fetchGamesByDate("2099-04-01");
  restoreFetch();
  assert.equal(games.available, true);
  assert.equal(games.games.length, 1);
  assert.equal(games.games[0].home.name, "Home FC");
  assert.equal(games.games[0].id, 7001);
});

delete process.env.API_SPORTS_KEY;
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
