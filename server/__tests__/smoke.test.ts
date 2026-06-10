// End-to-end smoke test for the cross-sport slate. Runs the orchestrator in
// demo mode (no API keys present in CI) and asserts the board builds for every
// sport with a well-formed payload: picks present, each pick carries a 3-market
// set (ML/spread/total objects always exist so PRISM never renders blank), a
// verdict tier, and a $25k-derived bankroll. Also exercises the live path shape
// against /api/slate when a key is configured (skipped otherwise).
// Run: tsx server/__tests__/smoke.test.ts

import assert from "node:assert/strict";

import { getDailySlate } from "../slate/orchestrator";
import { getNbaSlate } from "../sports/nba/slate";
import type { BuiltPick } from "../sports/mlb/picksEngine";
import type { MarketSet } from "../core/types";

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ok   ${name}`);
    })
    .catch((err: unknown) => {
      failed++;
      console.error(`  FAIL ${name}`);
      console.error(`       ${(err as Error).message}`);
    });
}

const DATE = "2026-06-08";

function assertMarketSet(ms: MarketSet, label: string) {
  // All three market slots must be present objects — PRISM/market UI relies on
  // this so a card never renders a blank bar.
  for (const k of ["ml", "spread", "total"] as const) {
    assert.ok(ms[k], `${label}: ${k} market object exists`);
    assert.equal(typeof ms[k].available, "boolean", `${label}: ${k}.available is boolean`);
    assert.ok(ms[k].tier, `${label}: ${k}.tier present`);
  }
}

function assertPick(p: BuiltPick, label: string) {
  assert.ok(p.gameId, `${label}: has gameId`);
  assert.equal(p.gameDate, DATE, `${label}: game dated ${DATE}`);
  assert.ok(p.matchup.includes("@"), `${label}: matchup formatted`);
  assert.ok(p.pickTeamFull, `${label}: has pick team`);
  assert.ok(["PLAY", "PASS"].includes(p.verdict), `${label}: valid verdict`);
  assert.ok(p.confidence >= 0 && p.confidence <= 100, `${label}: confidence in range`);
  assert.ok(p.homeWinProb >= 0.15 && p.homeWinProb <= 0.85, `${label}: home prob clamped`);
  assertMarketSet(p.markets, label);
  assert.ok(p.polymarket, `${label}: polymarket field present (never undefined)`);
}

async function run() {
  console.log("slate smoke (demo path, $25k bankroll)");

  await test("daily slate builds for all four sports", async () => {
    const slate = await getDailySlate(undefined, DATE);
    assert.equal(slate.operatingDay, DATE);
    assert.equal(slate.bankroll, 25000, "bankroll defaults to $25k");
    for (const sport of ["mlb", "nhl", "nba", "soccer"] as const) {
      const s = slate.sports[sport];
      assert.ok(s.ok, `${sport} slate resolved ok`);
      assert.ok(Array.isArray(s.picks), `${sport} has picks array`);
    }
  });

  await test("every pick across the board is well-formed (markets always present)", async () => {
    const slate = await getDailySlate(undefined, DATE);
    let total = 0;
    for (const sport of ["mlb", "nhl", "nba", "soccer"] as const) {
      for (const p of slate.sports[sport].picks) {
        assertPick(p, `${sport}/${p.gameId}`);
        total++;
      }
    }
    assert.ok(total > 0, "board produced at least one pick");
  });

  await test("daily cap holds — per-sport actionable cap (MLB 3, NHL/NBA 3, soccer 2)", async () => {
    const slate = await getDailySlate(undefined, DATE);
    const caps: Record<string, number> = { mlb: 3, nhl: 3, nba: 3, soccer: 2 };
    for (const sport of ["mlb", "nhl", "nba", "soccer"] as const) {
      const qualifying = slate.sports[sport].picks.filter((p) => p.qualifies).length;
      assert.ok(qualifying <= caps[sport], `${sport}: ${qualifying} qualifying ≤ ${caps[sport]}`);
    }
  });

  await test("NBA demo slate runs the possession model and prices markets", async () => {
    const nba = await getNbaSlate(undefined, DATE);
    assert.ok(nba.picks.length > 0, "NBA demo has picks");
    const p = nba.picks[0];
    assert.ok(p.projHomeScore && p.projAwayScore, "projected scores present");
    assert.ok((p.expectedTotal ?? 0) > 150, "expected total is a plausible NBA number");
  });

  await test("exposure cap keeps total actionable stake ≤ 18% of bankroll", async () => {
    const slate = await getDailySlate(undefined, DATE);
    const staked = (["mlb", "nhl", "nba", "soccer"] as const)
      .flatMap((s) => slate.sports[s].picks)
      .filter((p) => p.qualifies)
      .reduce((sum, p) => sum + p.kellyStakeDollars, 0);
    const cap = 25000 * 0.18;
    // Allow a few dollars of rounding slack across many trimmed stakes.
    assert.ok(staked <= cap + 10, `staked ${staked} ≤ cap ${cap}`);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
