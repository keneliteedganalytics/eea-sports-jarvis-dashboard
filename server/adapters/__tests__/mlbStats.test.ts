// Unit tests for the v6.13.2 MLB Stats API spot feeds (Rule 4 + Rule 6). Mocks
// global fetch so no network is touched. Covers: the division map (30 teams → 6
// divisions, with the live /teams payload), fetchSeriesContext identifying the
// trailing side after an 0-2 division series + positive run-diff gate, and
// fetchLast18MLRecord splitting home/away finals and computing win pct.
// Run: tsx server/adapters/__tests__/mlbStats.test.ts

import assert from "node:assert/strict";
import {
  fetchDivisionMap,
  fetchSeriesContext,
  fetchLast18MLRecord,
  fetchTeamRunDiffMap,
  _clearMlbStatsCaches,
} from "../mlbStats";
import { TEAM_DIVISION } from "../../sports/mlb/divisions";

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ok   ${name}`);
    })
    .catch((err) => {
      failed++;
      console.error(`  FAIL ${name}`);
      console.error(`       ${(err as Error).message}`);
    });
}
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

const originalFetch = globalThis.fetch;
function jsonResponse(body: unknown): Response {
  return {
    status: 200,
    headers: { forEach: () => {} },
    json: async () => body,
  } as unknown as Response;
}
type Handler = (url: string) => unknown;
function installFetch(handler: Handler) {
  (globalThis as { fetch: typeof fetch }).fetch = (async (input: unknown) => {
    const body = handler(String(input));
    return jsonResponse(body ?? {});
  }) as unknown as typeof fetch;
}

// /teams payload built from the verified static alignment (30 teams, 6 divs).
function teamsPayload() {
  return {
    teams: Object.entries(TEAM_DIVISION).map(([id, div]) => ({
      id: Number(id),
      division: { id: div },
    })),
  };
}

// A single final game row in the /schedule (team-filtered) shape.
function finalGame(
  date: string,
  homeId: number,
  awayId: number,
  homeScore: number,
  awayScore: number,
) {
  return {
    gamePk: Math.floor(Math.random() * 1e6),
    officialDate: date,
    gameType: "R",
    status: { detailedState: "Final" },
    teams: {
      home: { team: { id: homeId }, score: homeScore },
      away: { team: { id: awayId }, score: awayScore },
    },
  };
}

async function main() {
  console.log("MLB Stats spot feeds (v6.13.2)");

  await test("fetchDivisionMap → 30 teams across 6 divisions", async () => {
    _clearMlbStatsCaches();
    installFetch((url) => (url.includes("/teams") ? teamsPayload() : {}));
    const map = await fetchDivisionMap(2026);
    assert.equal(map.size, 30, `expected 30 teams, got ${map.size}`);
    const divs = new Set(map.values());
    assert.equal(divs.size, 6, `expected 6 divisions, got ${divs.size}`);
    assert.equal(map.get(147), 201, "Yankees in AL East (201)");
    assert.equal(map.get(111), 201, "Red Sox in AL East (201)");
  });

  await test("fetchDivisionMap → empty live payload falls back to static map", async () => {
    _clearMlbStatsCaches();
    installFetch(() => ({ teams: [] }));
    const map = await fetchDivisionMap(2026);
    assert.equal(map.size, 30, "static fallback yields all 30 teams");
    assert.equal(map.get(158), 205, "Brewers in NL West (205) per static map");
  });

  await test("fetchSeriesContext → trailing side after an 0-2 division series", async () => {
    _clearMlbStatsCaches();
    // Game 3 of a 3-game AL East series: Yankees (147) host Red Sox (111).
    // Red Sox won the first two → Yankees trail 0-2 (home side trails).
    installFetch((url) => {
      if (url.includes("/standings")) {
        return {
          records: [
            { teamRecords: [{ team: { id: 147 }, runDifferential: 35 }] },
          ],
        };
      }
      if (url.includes("/teams")) return teamsPayload();
      if (url.includes("teamId=")) {
        // Home team's (147) prior meetings vs Red Sox: both won by Boston.
        return {
          dates: [
            { games: [finalGame("2026-06-26", 147, 111, 2, 5)] },
            { games: [finalGame("2026-06-27", 111, 147, 6, 1)] },
          ],
        };
      }
      if (url.includes("/schedule")) {
        // The day's schedule entry carries the series position.
        return {
          dates: [
            {
              games: [
                {
                  gamePk: 999,
                  gameDate: "2026-06-28T17:00:00Z",
                  seriesGameNumber: 3,
                  gamesInSeries: 3,
                  teams: {
                    home: { team: { id: 147, name: "New York Yankees" } },
                    away: { team: { id: 111, name: "Boston Red Sox" } },
                  },
                },
              ],
            },
          ],
        };
      }
      return {};
    });

    const ctx = await fetchSeriesContext(999, 111, 147, "2026-06-28");
    assert.ok(ctx, "context resolved");
    assert.equal(ctx!.sameDivision, true, "Yankees & Red Sox share AL East");
    assert.equal(ctx!.seriesLength, 3);
    assert.equal(ctx!.gameNumberInSeries, 3);
    assert.equal(ctx!.trailingTeamLostFirstTwo, true, "host lost the first two");
    assert.equal(ctx!.trailingSide, "home", "Yankees (home) trail 0-2");
    assert.equal(ctx!.trailingTeamPositiveRunDiff, true, "Yankees +35 run diff");
  });

  await test("fetchSeriesContext → split series (1-1) does not fire", async () => {
    _clearMlbStatsCaches();
    installFetch((url) => {
      if (url.includes("/standings")) return { records: [] };
      if (url.includes("/teams")) return teamsPayload();
      if (url.includes("teamId=")) {
        // Split: each team won one.
        return {
          dates: [
            { games: [finalGame("2026-06-26", 147, 111, 5, 2)] },
            { games: [finalGame("2026-06-27", 111, 147, 6, 1)] },
          ],
        };
      }
      if (url.includes("/schedule")) {
        return {
          dates: [
            {
              games: [
                {
                  gamePk: 1000,
                  gameDate: "2026-06-28T17:00:00Z",
                  seriesGameNumber: 3,
                  gamesInSeries: 3,
                  teams: {
                    home: { team: { id: 147, name: "New York Yankees" } },
                    away: { team: { id: 111, name: "Boston Red Sox" } },
                  },
                },
              ],
            },
          ],
        };
      }
      return {};
    });
    const ctx = await fetchSeriesContext(1000, 111, 147, "2026-06-28");
    assert.ok(ctx, "context resolved");
    assert.equal(ctx!.trailingTeamLostFirstTwo, false, "no team is up 2-0");
    assert.equal(ctx!.trailingSide, null);
  });

  await test("fetchLast18MLRecord → splits home/away finals + win pct", async () => {
    _clearMlbStatsCaches();
    const TEAM = 147;
    const OPP = 111;
    // 18 home games: 12 wins; 18 away games: 6 wins.
    const games: ReturnType<typeof finalGame>[] = [];
    for (let i = 0; i < 18; i++) {
      const win = i < 12;
      games.push(finalGame(`2026-05-${String(i + 1).padStart(2, "0")}`, TEAM, OPP, win ? 5 : 1, win ? 1 : 5));
    }
    for (let i = 0; i < 18; i++) {
      const win = i < 6;
      games.push(finalGame(`2026-04-${String(i + 1).padStart(2, "0")}`, OPP, TEAM, win ? 1 : 5, win ? 5 : 1));
    }
    installFetch((url) => {
      if (url.includes("teamId=")) return { dates: [{ games }] };
      return {};
    });
    const rec = await fetchLast18MLRecord(TEAM, "2026-06-28", 2026);
    assert.ok(rec, "record resolved");
    assert.ok(near(rec!.homeWinPct as number, 12 / 18), `homeWinPct ${rec!.homeWinPct}`);
    assert.ok(near(rec!.awayWinPct as number, 6 / 18), `awayWinPct ${rec!.awayWinPct}`);
  });

  await test("fetchLast18MLRecord → caps at most-recent 18 per venue", async () => {
    _clearMlbStatsCaches();
    const TEAM = 147;
    const OPP = 111;
    // 25 home games chronologically: first 25 losses... actually make the most
    // recent 18 all wins and the oldest 7 losses, to prove we take the tail.
    const games: ReturnType<typeof finalGame>[] = [];
    for (let i = 0; i < 25; i++) {
      const win = i >= 7; // oldest 7 lose, newest 18 win
      games.push(finalGame(`2026-05-${String(i + 1).padStart(2, "0")}`, TEAM, OPP, win ? 5 : 1, win ? 1 : 5));
    }
    installFetch((url) => {
      if (url.includes("teamId=")) return { dates: [{ games }] };
      return {};
    });
    const rec = await fetchLast18MLRecord(TEAM, "2026-06-28", 2026);
    assert.ok(rec, "record resolved");
    assert.ok(near(rec!.homeWinPct as number, 1.0), `homeWinPct ${rec!.homeWinPct} (last 18 all wins)`);
    assert.equal(rec!.awayWinPct, null, "no away games → null");
  });

  await test("fetchTeamRunDiffMap → maps team → run differential", async () => {
    _clearMlbStatsCaches();
    installFetch((url) => {
      if (url.includes("/standings")) {
        return {
          records: [
            { teamRecords: [{ team: { id: 147 }, runsScored: 400, runsAllowed: 365 }] },
            { teamRecords: [{ team: { id: 111 }, runDifferential: -12 }] },
          ],
        };
      }
      return {};
    });
    const map = await fetchTeamRunDiffMap(2026);
    assert.equal(map.get(147), 35, "computed from runsScored - runsAllowed");
    assert.equal(map.get(111), -12, "uses runDifferential when present");
  });

  await test("network error → null context / null record (never throws)", async () => {
    _clearMlbStatsCaches();
    (globalThis as { fetch: typeof fetch }).fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    // Division map still returns the static fallback (best-effort).
    const map = await fetchDivisionMap(2026);
    assert.equal(map.size, 30, "static fallback survives a network error");
    const rec = await fetchLast18MLRecord(147, "2026-06-28", 2026);
    assert.ok(rec && rec.homeWinPct === null && rec.awayWinPct === null, "empty record");
  });

  globalThis.fetch = originalFetch;
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
