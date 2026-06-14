// v6.9.0 — unified prediction-market wrapper (Polymarket primary, Kalshi fallback).
// Proves: a Polymarket hit short-circuits and is venue-tagged "polymarket"; a
// Polymarket miss falls through to Kalshi (which, with no live HTTP in tests,
// degrades to found:false carrying the more-informative polymarket reason); the
// wrapper never throws. Uses the seedable Polymarket cache so the primary path is
// deterministic without network. Run: tsx server/__tests__/predictionMarkets.test.ts

import assert from "node:assert/strict";
import {
  __seedPolymarketCache,
  __clearPolymarketCache,
  type GammaEvent,
} from "../adapters/polymarket";
import { fetchPredictionMarketForGame } from "../adapters/predictionMarkets";

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

console.log("v6.9.0 — prediction markets (polymarket + kalshi fallback)");

// A minimal Gamma event that prices Yankees vs Guardians for 2026-06-14.
const seedEvent: GammaEvent = {
  id: "1",
  slug: "mlb-cle-nyy-2026-06-14",
  title: "Guardians @ Yankees",
  endDate: "2026-06-15T03:00:00Z",
  active: true,
  closed: false,
  markets: [
    {
      question: "Yankees vs Guardians",
      slug: "mlb-cle-nyy-2026-06-14",
      outcomes: '["New York Yankees","Cleveland Guardians"]',
      outcomePrices: '["0.62","0.38"]',
      closed: false,
      endDate: "2026-06-15T03:00:00Z",
    },
  ],
};

await test("polymarket hit short-circuits and is venue-tagged polymarket", async () => {
  __clearPolymarketCache();
  __seedPolymarketCache("mlb", [seedEvent]);
  const r = await fetchPredictionMarketForGame(
    "New York Yankees", "Cleveland Guardians", "2026-06-14", "home", "mlb",
  );
  assert.equal(r.found, true, r.reason);
  assert.equal(r.venue, "polymarket");
  assert.ok(r.pct !== null && Math.abs(r.pct - 62) < 1, `got ${r.pct}`);
});

await test("away pick reads the opposing price off the same event", async () => {
  __clearPolymarketCache();
  __seedPolymarketCache("mlb", [seedEvent]);
  const r = await fetchPredictionMarketForGame(
    "New York Yankees", "Cleveland Guardians", "2026-06-14", "away", "mlb",
  );
  assert.equal(r.found, true, r.reason);
  assert.equal(r.venue, "polymarket");
  assert.ok(r.pct !== null && Math.abs(r.pct - 38) < 1, `got ${r.pct}`);
});

await test("polymarket miss falls through to kalshi, degrades to found:false, never throws", async () => {
  __clearPolymarketCache();
  // Seed an empty list so polymarket finds no market; kalshi has no test HTTP, so
  // the unified result must be a clean found:false (not an exception).
  __seedPolymarketCache("mlb", []);
  const r = await fetchPredictionMarketForGame(
    "Nonexistent Team A", "Nonexistent Team B", "2026-06-14", "home", "mlb",
  );
  assert.equal(r.found, false);
  assert.equal(r.venue, null);
  assert.ok(typeof r.reason === "string" && r.reason.length > 0, "expected a reason string");
});

await test("unsupported sport for kalshi still returns a clean miss", async () => {
  __clearPolymarketCache();
  __seedPolymarketCache("nba", []);
  const r = await fetchPredictionMarketForGame(
    "Team A", "Team B", "2026-06-14", "home", "nba",
  );
  assert.equal(r.found, false);
  assert.equal(r.venue, null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
