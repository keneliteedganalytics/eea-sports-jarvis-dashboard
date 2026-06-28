// Integration tests for the v6.13.1 Savant feed → model wiring. Mocks global
// fetch to serve sample Savant CSVs, resolves a merged StarterStatcast profile
// through getCachedSavantProfile, and asserts that feeding it into predictGame
// fires Rules 1-3. Also asserts the regression-safety guarantee: when the Savant
// feed is unavailable (every fetch errors → null profile) the model reproduces
// the bare-context output exactly (identical to v6.13.0 no-op behavior).
// Run: tsx server/sports/mlb/__tests__/savantIntegration.test.ts

import assert from "node:assert/strict";
import { getCachedSavantProfile, _clearSavantCache } from "../../../adapters/savantStats";
import { predictGame, type ModelContext } from "../model";
import type { StarterStatcast } from "../hatfieldRules";

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
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

const BOM = "﻿";
// Barrels/sweet-spot at league average for everyone → Rule 2 is a no-op (score
// 50), so each rule can be isolated cleanly below.
const BARRELS_CSV =
  BOM +
  `"last_name, first_name","player_id","attempts","avg_hit_angle","anglesweetspotpercent","max_hit_speed","avg_hit_speed","ev50","fbld","gb","max_distance","avg_distance","avg_hr_distance","ev95plus","ev95percent","barrels","brl_percent","brl_pa"\n` +
  `"Home, SP","2001","500","10",33.3,"113","88","77","93","84","425","150","385","230",40,"35",7.0,4.9\n` +
  `"Away, SP","2002","500","10",33.3,"113","88","77","93","84","425","150","385","230",40,"35",7.0,4.9\n`;

// Scenario A — Rule 1 only: away SP (2002) overperforms xERA by 1.30; walk
// rates BELOW the 10% threshold so Rule 3 stays silent.
const EXPECTED_A =
  BOM +
  `"last_name, first_name","player_id","year","pa","bip","ba","est_ba","est_ba_minus_ba_diff","slg","est_slg","est_slg_minus_slg_diff","woba","est_woba","est_woba_minus_woba_diff","era","xera","era_minus_xera_diff"\n` +
  `"Home, SP","2001","2026","700","500",0.240,0.240,0,0.4,0.4,0,0.31,0.31,0,"4.00","4.00","0.00"\n` +
  `"Away, SP","2002","2026","700","500",0.240,0.240,0,0.4,0.4,0,0.31,0.31,0,"2.50","3.80","-1.30"\n`;
const WALKS_A =
  BOM +
  `"last_name, first_name","player_id","year","pa","walk","k_percent","bb_percent"\n` +
  `"Home, SP","2001",2026,700,55,22,7.8\n` +
  `"Away, SP","2002",2026,700,55,22,8.0\n`;

// Scenario B — Rule 3 only: ERA == xERA for both (no fade); both walk >= 10%.
const EXPECTED_B =
  BOM +
  `"last_name, first_name","player_id","year","pa","bip","ba","est_ba","est_ba_minus_ba_diff","slg","est_slg","est_slg_minus_slg_diff","woba","est_woba","est_woba_minus_woba_diff","era","xera","era_minus_xera_diff"\n` +
  `"Home, SP","2001","2026","700","500",0.240,0.240,0,0.4,0.4,0,0.31,0.31,0,"4.00","4.00","0.00"\n` +
  `"Away, SP","2002","2026","700","500",0.240,0.240,0,0.4,0.4,0,0.31,0.31,0,"4.00","4.00","0.00"\n`;
const WALKS_B =
  BOM +
  `"last_name, first_name","player_id","year","pa","walk","k_percent","bb_percent"\n` +
  `"Home, SP","2001",2026,700,90,22,12.0\n` +
  `"Away, SP","2002",2026,700,85,22,11.0\n`;

function csvResponse(body: string): Response {
  return { status: 200, text: async () => body } as unknown as Response;
}
function installFetch(expected: string, walks: string) {
  (globalThis as { fetch: typeof fetch }).fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.includes("expected_statistics")) return csvResponse(expected);
    if (url.includes("/statcast")) return csvResponse(BARRELS_CSV);
    if (url.includes("/custom")) return csvResponse(walks);
    return { status: 404, text: async () => "" } as unknown as Response;
  }) as unknown as typeof fetch;
}
const originalFetch = globalThis.fetch;

function baseCtx(): ModelContext {
  return {
    homeTeam: "CHC",
    awayTeam: "COL",
    homeTeamFull: "Chicago Cubs",
    awayTeamFull: "Colorado Rockies",
    homeSpStats: { available: true, pitcher: "P1", era: 4.0, fip: 3.9, ip: 80 } as never,
    awaySpStats: { available: true, pitcher: "P2", era: 4.5, fip: 4.4, ip: 75 } as never,
    homeOffStats: { available: true, ops: 0.74, rpg: 4.6 } as never,
    awayOffStats: { available: true, ops: 0.7, rpg: 4.3 } as never,
    venueTriCode: "CHC",
    homeFairProb: 0.55,
    awayFairProb: 0.45,
  };
}

async function main() {
  console.log("Savant → model integration (v6.13.1)");

  await test("Scenario A — Savant feed fires Rule 1 (away fade → +0.20 home runs)", async () => {
    _clearSavantCache();
    installFetch(EXPECTED_A, WALKS_A);
    const homeSpStatcast = await getCachedSavantProfile(2001, 2026);
    const awaySpStatcast = await getCachedSavantProfile(2002, 2026);
    assert.ok(homeSpStatcast && awaySpStatcast, "profiles resolved");
    // Sanity: the away SP carries the overperforming ERA/xERA from the CSV.
    assert.ok(near(awaySpStatcast!.era as number, 2.5));
    assert.ok(near(awaySpStatcast!.xera as number, 3.8));
    assert.ok(near(awaySpStatcast!.bbPct as number, 8.0));

    const baseline = predictGame(baseCtx());
    const withSavant = predictGame({ ...baseCtx(), homeSpStatcast, awaySpStatcast });

    assert.equal(withSavant.awayFadeFlag, true);
    assert.equal(withSavant.baseTrafficOverTilt, false); // walks below threshold
    assert.ok(
      near(withSavant.projHomeScore - baseline.projHomeScore, 0.2),
      `home runs delta ${withSavant.projHomeScore - baseline.projHomeScore}`,
    );
  });

  await test("Scenario B — Savant feed fires Rule 3 (both walk → +0.50 total)", async () => {
    _clearSavantCache();
    installFetch(EXPECTED_B, WALKS_B);
    const homeSpStatcast = await getCachedSavantProfile(2001, 2026);
    const awaySpStatcast = await getCachedSavantProfile(2002, 2026);
    assert.ok(homeSpStatcast && awaySpStatcast, "profiles resolved");
    assert.ok(near(homeSpStatcast!.bbPct as number, 12.0));

    const baseline = predictGame(baseCtx());
    const withSavant = predictGame({ ...baseCtx(), homeSpStatcast, awaySpStatcast });

    assert.equal(withSavant.awayFadeFlag, false); // ERA == xERA, no fade
    assert.equal(withSavant.baseTrafficOverTilt, true);
    assert.ok(
      near(withSavant.expectedTotalRuns - baseline.expectedTotalRuns, 0.5),
      `total delta ${withSavant.expectedTotalRuns - baseline.expectedTotalRuns}`,
    );
  });

  await test("Savant unavailable (all fetches error) → null profile → no-op", async () => {
    _clearSavantCache();
    (globalThis as { fetch: typeof fetch }).fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const homeSpStatcast = await getCachedSavantProfile(2001, 2026);
    const awaySpStatcast = await getCachedSavantProfile(2002, 2026);
    assert.equal(homeSpStatcast, null);
    assert.equal(awaySpStatcast, null);

    const baseline = predictGame(baseCtx());
    const withNull = predictGame({
      ...baseCtx(),
      homeSpStatcast: homeSpStatcast as StarterStatcast | null,
      awaySpStatcast: awaySpStatcast as StarterStatcast | null,
      seriesContext: null,
    });
    for (const k of ["projHomeScore", "projAwayScore", "expectedTotalRuns", "homeWinProb"] as const) {
      assert.ok(
        near(baseline[k] as number, withNull[k] as number),
        `${k}: ${baseline[k]} vs ${withNull[k]}`,
      );
    }
    assert.equal(withNull.awayFadeFlag, false);
    assert.equal(withNull.baseTrafficOverTilt, false);
  });

  globalThis.fetch = originalFetch;
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
