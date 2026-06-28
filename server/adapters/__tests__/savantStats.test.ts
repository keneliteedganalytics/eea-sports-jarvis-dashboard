// Unit tests for the Baseball Savant CSV adapter (v6.13.1). Mocks global fetch
// so no network is touched: covers the RFC4180 parser (BOM + quoted comma in
// the "last_name, first_name" header), numeric typing, HTTP-error/malformed
// degradation to empty Map (never throws), the merged profile, and the 24h
// season-table cache (a second profile read does not re-fetch).
// Run: tsx server/adapters/__tests__/savantStats.test.ts

import assert from "node:assert/strict";
import {
  parseCsv,
  fetchSavantExpectedStats,
  fetchSavantBarrels,
  fetchSavantWalkRates,
  fetchSavantPitcherProfile,
  getCachedSavantProfile,
  refreshSeasonTables,
  _clearSavantCache,
} from "../savantStats";

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

// Sample CSV fixtures mirroring the live schemas (BOM + quoted first column).
const BOM = "﻿";
const EXPECTED_CSV =
  BOM +
  `"last_name, first_name","player_id","year","pa","bip","ba","est_ba","est_ba_minus_ba_diff","slg","est_slg","est_slg_minus_slg_diff","woba","est_woba","est_woba_minus_woba_diff","era","xera","era_minus_xera_diff"\n` +
  `"Gray, Sonny","543243","2024","800","600",0.300,0.300,0,0.5,0.5,0,0.3,0.3,0,"2.50","3.80","-1.30"\n` +
  `"Rodón, Carlos","607074","2024","790","580",0.220,0.224,-0.004,0.4,0.4,0,0.29,0.29,0,"3.00","2.95","0.05"\n` +
  `"League, Avg","999999","2024","700","500",0.240,0.240,0,0.4,0.4,0,0.31,0.31,0,"4.00","4.00","0.00"\n`;

const BARRELS_CSV =
  BOM +
  `"last_name, first_name","player_id","attempts","avg_hit_angle","anglesweetspotpercent","max_hit_speed","avg_hit_speed","ev50","fbld","gb","max_distance","avg_distance","avg_hr_distance","ev95plus","ev95percent","barrels","brl_percent","brl_pa"\n` +
  `"Gray, Sonny","543243","600","12",36.5,"115","89","78","94","85","440","160","400","250",42,"40",11,5\n` +
  `"Rodón, Carlos","607074","580","11",32,"114","88","77","93","84","430","155","390","240",41,"34",5.8,4.8\n` +
  `"League, Avg","999999","500","10",33.3,"113","88","77","93","84","425","150","385","230",40,"35",7.0,4.9\n`;

const WALKS_CSV =
  BOM +
  `"last_name, first_name","player_id","year","pa","walk","k_percent","bb_percent"\n` +
  `"Gray, Sonny","543243",2024,800,65,28,8.1\n` +
  `"Rodón, Carlos","607074",2024,790,90,30,11.4\n` +
  `"League, Avg","999999",2024,700,55,22,7.8\n`;

function csvResponse(body: string): Response {
  return { status: 200, text: async () => body } as unknown as Response;
}
function errorResponse(status: number): Response {
  return { status, text: async () => "" } as unknown as Response;
}

// Route a mock fetch by URL substring.
function installFetch(handler: (url: string) => Response | Promise<Response>) {
  (globalThis as { fetch: typeof fetch }).fetch = (async (input: unknown) =>
    handler(String(input))) as unknown as typeof fetch;
}

const originalFetch = globalThis.fetch;

async function main() {
  console.log("Baseball Savant CSV adapter (v6.13.1)");

  // ── parser ──────────────────────────────────────────────────────────────
  await test("parseCsv: strips BOM and keeps quoted comma in header column", () => {
    const recs = parseCsv(EXPECTED_CSV);
    assert.equal(recs.length, 3);
    // The first header is the single field "last_name, first_name".
    assert.ok("last_name, first_name" in recs[0]);
    assert.equal(recs[0]["player_id"], "543243");
    assert.equal(recs[0]["est_ba"], "0.300");
  });
  await test("parseCsv: empty input → empty array", () => {
    assert.deepEqual(parseCsv(""), []);
  });

  // ── expected stats ────────────────────────────────────────────────────────
  await test("fetchSavantExpectedStats: numeric typing of xBA/era/xera", async () => {
    installFetch(() => csvResponse(EXPECTED_CSV));
    const m = await fetchSavantExpectedStats(2024);
    assert.equal(m.size, 3);
    const gray = m.get(543243)!;
    assert.ok(near(gray.xba as number, 0.3));
    assert.ok(near(gray.era as number, 2.5));
    assert.ok(near(gray.xera as number, 3.8));
  });

  await test("fetchSavantBarrels: brl_percent + anglesweetspotpercent", async () => {
    installFetch(() => csvResponse(BARRELS_CSV));
    const m = await fetchSavantBarrels(2024);
    const rodon = m.get(607074)!;
    assert.ok(near(rodon.barrelRatePct as number, 5.8));
    assert.ok(near(rodon.sweetSpotPct as number, 32));
  });

  await test("fetchSavantWalkRates: bb_percent", async () => {
    installFetch(() => csvResponse(WALKS_CSV));
    const m = await fetchSavantWalkRates(2024);
    assert.ok(near(m.get(607074)!.bbPct as number, 11.4));
  });

  // ── degradation ───────────────────────────────────────────────────────────
  await test("HTTP 500 → empty Map, no throw", async () => {
    installFetch(() => errorResponse(500));
    const m = await fetchSavantExpectedStats(2024);
    assert.equal(m.size, 0);
  });
  await test("fetch rejects (network error) → empty Map, no throw", async () => {
    (globalThis as { fetch: typeof fetch }).fetch = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const m = await fetchSavantBarrels(2024);
    assert.equal(m.size, 0);
  });
  await test("malformed CSV (header only) → empty Map", async () => {
    installFetch(() => csvResponse(BOM + `"last_name, first_name","player_id"\n`));
    const m = await fetchSavantExpectedStats(2024);
    assert.equal(m.size, 0);
  });

  // ── merged profile ──────────────────────────────────────────────────────
  await test("fetchSavantPitcherProfile: merges all three leaderboards", async () => {
    _clearSavantCache();
    installFetch((url) => {
      if (url.includes("expected_statistics")) return csvResponse(EXPECTED_CSV);
      if (url.includes("/statcast")) return csvResponse(BARRELS_CSV);
      if (url.includes("/custom")) return csvResponse(WALKS_CSV);
      return errorResponse(404);
    });
    const rodon = await fetchSavantPitcherProfile(607074, 2024);
    assert.ok(rodon);
    assert.ok(near(rodon!.xbaAllowed as number, 0.224));
    assert.ok(near(rodon!.era as number, 3.0));
    assert.ok(near(rodon!.xera as number, 2.95));
    assert.ok(near(rodon!.barrelRatePct as number, 5.8));
    assert.ok(near(rodon!.sweetSpotPct as number, 32));
    assert.ok(near(rodon!.bbPct as number, 11.4));
  });

  await test("fetchSavantPitcherProfile: unknown pitcher → null", async () => {
    _clearSavantCache();
    installFetch((url) => {
      if (url.includes("expected_statistics")) return csvResponse(EXPECTED_CSV);
      if (url.includes("/statcast")) return csvResponse(BARRELS_CSV);
      if (url.includes("/custom")) return csvResponse(WALKS_CSV);
      return errorResponse(404);
    });
    assert.equal(await fetchSavantPitcherProfile(111111, 2024), null);
  });

  await test("null playerId → null without fetching", async () => {
    let called = false;
    installFetch(() => {
      called = true;
      return csvResponse(EXPECTED_CSV);
    });
    assert.equal(await fetchSavantPitcherProfile(null, 2024), null);
    assert.equal(called, false);
  });

  // ── cache ─────────────────────────────────────────────────────────────────
  await test("season tables cached: second profile read does NOT re-fetch", async () => {
    _clearSavantCache();
    let fetches = 0;
    installFetch((url) => {
      fetches++;
      if (url.includes("expected_statistics")) return csvResponse(EXPECTED_CSV);
      if (url.includes("/statcast")) return csvResponse(BARRELS_CSV);
      if (url.includes("/custom")) return csvResponse(WALKS_CSV);
      return errorResponse(404);
    });
    await getCachedSavantProfile(543243, 2024); // 3 fetches (one per leaderboard)
    const afterFirst = fetches;
    assert.equal(afterFirst, 3);
    await getCachedSavantProfile(607074, 2024); // served from cache → no new fetches
    assert.equal(fetches, afterFirst);
  });

  await test("refreshSeasonTables: returns row counts and repopulates cache", async () => {
    _clearSavantCache();
    installFetch((url) => {
      if (url.includes("expected_statistics")) return csvResponse(EXPECTED_CSV);
      if (url.includes("/statcast")) return csvResponse(BARRELS_CSV);
      if (url.includes("/custom")) return csvResponse(WALKS_CSV);
      return errorResponse(404);
    });
    const t = await refreshSeasonTables(2024);
    assert.equal(t.expected.size, 3);
    assert.equal(t.barrels.size, 3);
    assert.equal(t.walks.size, 3);
  });

  globalThis.fetch = originalFetch;
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
