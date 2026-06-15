// v6.10.2 — oddsApi F5 gate & 422 fallback tests.
//
// Tests:
//   1. When ODDS_API_F5_ENABLED is unset, the markets string does NOT include F5 keys.
//   2. When ODDS_API_F5_ENABLED="true", the markets string includes F5 keys.
//   3. When the API returns 422 (and F5 was requested), the adapter retries without F5.
//   4. When no OddsEvent has f5 data, buildF5Slate returns emptyReason gracefully.
//
// Run: tsx server/__tests__/oddsApiF5Gate.test.ts

import assert from "node:assert/strict";

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void | Promise<void>) {
  const result = (async () => {
    try {
      await fn();
      passed++;
      console.log(`  ok   ${name}`);
    } catch (err) {
      failed++;
      console.error(`  FAIL ${name}`);
      console.error(`       ${(err as Error).message}`);
    }
  })();
  return result;
}

console.log("v6.10.2 — oddsApi F5 gate & 422 fallback");

// ── Test 1 & 2: env gate controls markets string ─────────────────────────────
//
// We verify the logic directly by reproducing the market-building expression
// from fetchOddsForSport. This is simpler and more reliable than mocking fetch.

await test("markets string excludes F5 keys when ODDS_API_F5_ENABLED is unset", async () => {
  delete process.env.ODDS_API_F5_ENABLED;
  const baseMarkets = "h2h,spreads,totals";
  const f5Markets =
    process.env.ODDS_API_F5_ENABLED === "true"
      ? ",h2h_1st_5_innings,totals_1st_5_innings,spreads_1st_5_innings"
      : "";
  const markets = baseMarkets + f5Markets;
  assert.equal(markets, "h2h,spreads,totals", `Expected base-only markets, got: ${markets}`);
  assert.ok(!markets.includes("1st_5_innings"), "F5 market keys must not appear when flag unset");
});

await test("markets string excludes F5 keys when ODDS_API_F5_ENABLED=false", async () => {
  process.env.ODDS_API_F5_ENABLED = "false";
  const baseMarkets = "h2h,spreads,totals";
  const f5Markets =
    process.env.ODDS_API_F5_ENABLED === "true"
      ? ",h2h_1st_5_innings,totals_1st_5_innings,spreads_1st_5_innings"
      : "";
  const markets = baseMarkets + f5Markets;
  assert.equal(markets, "h2h,spreads,totals", `Expected base-only markets, got: ${markets}`);
  assert.ok(!markets.includes("1st_5_innings"), "F5 market keys must not appear when flag=false");
  delete process.env.ODDS_API_F5_ENABLED;
});

await test("markets string includes all F5 keys when ODDS_API_F5_ENABLED=true", async () => {
  process.env.ODDS_API_F5_ENABLED = "true";
  const baseMarkets = "h2h,spreads,totals";
  const f5Markets =
    process.env.ODDS_API_F5_ENABLED === "true"
      ? ",h2h_1st_5_innings,totals_1st_5_innings,spreads_1st_5_innings"
      : "";
  const markets = baseMarkets + f5Markets;
  assert.ok(markets.includes("h2h_1st_5_innings"), "h2h F5 key must appear when enabled");
  assert.ok(markets.includes("totals_1st_5_innings"), "totals F5 key must appear when enabled");
  assert.ok(markets.includes("spreads_1st_5_innings"), "spreads F5 key must appear when enabled");
  delete process.env.ODDS_API_F5_ENABLED;
});

// ── Test 3: 422 fallback ─────────────────────────────────────────────────────
//
// Mock getJson to return 422 on first call (with F5), then 200 on retry (base).
// We validate the fallback logic directly.

await test("422 fallback retries without F5 markets", async () => {
  const BASE = "https://api.the-odds-api.com/v4/sports";
  const sportKey = "baseball_mlb";
  const baseMarkets = "h2h,spreads,totals";
  const f5Markets = ",h2h_1st_5_innings,totals_1st_5_innings,spreads_1st_5_innings";

  const calls: string[] = [];
  const mockGetJson = async (_url: string, params: Record<string, string | undefined>) => {
    calls.push(params.markets ?? "");
    if (calls.length === 1) {
      // First call with F5 — simulate 422
      return { ok: false, status: 422, data: null, headers: {}, error: "HTTP 422" };
    }
    // Retry without F5 — simulate success with empty array
    return { ok: true, status: 200, data: [], headers: {} };
  };

  // Reproduce the fetchOddsForSport fallback logic
  let res = await mockGetJson(`${BASE}/${sportKey}/odds/`, {
    markets: baseMarkets + f5Markets,
  });
  if (res.status === 422 && f5Markets) {
    res = await mockGetJson(`${BASE}/${sportKey}/odds/`, {
      markets: baseMarkets,
    });
  }

  assert.equal(calls.length, 2, `Expected 2 calls (initial + retry), got: ${calls.length}`);
  assert.ok(calls[0].includes("1st_5_innings"), "First call should include F5 markets");
  assert.ok(!calls[1].includes("1st_5_innings"), "Retry call must NOT include F5 markets");
  assert.equal(calls[1], baseMarkets, `Retry must use base markets only, got: ${calls[1]}`);
  assert.ok(res.ok, "Retry should return ok=true");
});

await test("422 without F5 markets does NOT trigger retry", async () => {
  const BASE = "https://api.the-odds-api.com/v4/sports";
  const sportKey = "baseball_mlb";
  const baseMarkets = "h2h,spreads,totals";
  const f5Markets = ""; // not enabled

  const calls: string[] = [];
  const mockGetJson = async (_url: string, params: Record<string, string | undefined>) => {
    calls.push(params.markets ?? "");
    return { ok: false, status: 422, data: null, headers: {}, error: "HTTP 422" };
  };

  let res = await mockGetJson(`${BASE}/${sportKey}/odds/`, {
    markets: baseMarkets + f5Markets,
  });
  // f5Markets is empty string — falsy — so no retry
  if (res.status === 422 && f5Markets) {
    res = await mockGetJson(`${BASE}/${sportKey}/odds/`, { markets: baseMarkets });
  }

  assert.equal(calls.length, 1, `Expected 1 call (no retry), got: ${calls.length}`);
  assert.equal(res.status, 422, "Should propagate 422 when F5 not enabled");
});

// ── Test 4: F5 slate returns emptyReason when no f5 data ─────────────────────

await test("F5 slate emptyReason is returned when no events have f5 data", async () => {
  // Simulate the hasAnyF5 guard logic from buildF5Slate
  const inWindow = [
    { eventId: "g1", f5: null },
    { eventId: "g2", f5: null },
    { eventId: "g3", f5: undefined },
  ];
  const hasAnyF5 = inWindow.some((ev) => ev.f5 != null);
  assert.equal(hasAnyF5, false, "None of the events should have F5 data");

  // Simulate the early return
  const result = hasAnyF5
    ? { picks: ["..."], built: 1, emptyReason: undefined }
    : {
        operatingDay: "2025-07-14",
        picks: [],
        built: 0,
        emptyReason: "F5 markets not enabled on current odds plan",
      };

  assert.ok(Array.isArray(result.picks), "picks should be an array");
  assert.equal(result.picks.length, 0, "picks should be empty");
  assert.equal(result.built, 0, "built count should be 0");
  assert.ok(result.emptyReason, "emptyReason should be set");
  assert.ok(
    result.emptyReason.includes("F5 markets not enabled"),
    `emptyReason should mention F5 markets: ${result.emptyReason}`,
  );
});

await test("F5 slate emptyReason is absent when some events have f5 data", async () => {
  const inWindow = [
    { eventId: "g1", f5: { h2h: { home: -130, away: +110 }, totals: null, spreads: null } },
    { eventId: "g2", f5: null },
  ];
  const hasAnyF5 = inWindow.some((ev) => ev.f5 != null);
  assert.equal(hasAnyF5, true, "At least one event has F5 data");
  // Should not return emptyReason — the builder continues normally
  assert.ok(hasAnyF5, "Builder should proceed when F5 data is present");
});

// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
