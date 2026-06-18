// Polymarket adapter tests — real fixtures captured 2026-06-08 from the Gamma
// events API. Verifies multi-sport matching, pick-side pricing, date windowing,
// and graceful no-market fallback. Run: tsx server/__tests__/polymarket.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  matchEvent,
  __seedPolymarketCache,
  __clearPolymarketCache,
  fetchPolymarketForGame,
  type GammaEvent,
} from "../adapters/polymarket";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fx = (name: string): GammaEvent[] =>
  JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf8"));

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

console.log("polymarket adapter");

const nhl = fx("poly-nhl-car-las.json");
const nba = fx("poly-nba-sas-nyk.json");
const mlb = fx("poly-mlb-nyy-cle.json");

await test("NHL: Hurricanes @ Golden Knights — away pick price matched", () => {
  const r = matchEvent(nhl, "Vegas Golden Knights", "Carolina Hurricanes", "2026-06-09", "away");
  assert.equal(r.found, true, r.reason);
  // Hurricanes priced 0.505 → 50.5
  assert.ok(r.pct !== null && Math.abs(r.pct - 50.5) < 0.6, `got ${r.pct}`);
});

await test("NHL: home pick (Golden Knights) price matched", () => {
  const r = matchEvent(nhl, "Vegas Golden Knights", "Carolina Hurricanes", "2026-06-09", "home");
  assert.equal(r.found, true, r.reason);
  assert.ok(r.pct !== null && Math.abs(r.pct - 49.5) < 0.6, `got ${r.pct}`);
});

await test("NBA: Spurs @ Knicks — finds ML among 100+ markets", () => {
  const r = matchEvent(nba, "New York Knicks", "San Antonio Spurs", "2026-06-08", "home");
  assert.equal(r.found, true, r.reason);
  assert.ok(r.pct !== null && r.pct > 0 && r.pct < 100, `got ${r.pct}`);
});

await test("MLB: Yankees @ Guardians — full team name outcomes matched", () => {
  // Polymarket lists full names; pick Guardians (home) priced 0.545 → 54.5
  const r = matchEvent(mlb, "Cleveland Guardians", "New York Yankees", "2026-06-08", "home");
  assert.equal(r.found, true, r.reason);
  assert.ok(r.pct !== null && Math.abs(r.pct - 54.5) < 0.6, `got ${r.pct}`);
});

await test("no market: unknown matchup returns found=false with reason", () => {
  const r = matchEvent(nhl, "Boston Bruins", "Florida Panthers", "2026-06-09", "home");
  assert.equal(r.found, false);
  assert.equal(r.pct, null);
  assert.ok(typeof r.reason === "string" && r.reason.length > 0);
});

await test("date window: same teams but far-off date is rejected", () => {
  const r = matchEvent(nhl, "Vegas Golden Knights", "Carolina Hurricanes", "2026-08-01", "home");
  assert.equal(r.found, false, "should not match a game 7+ weeks away");
});

await test("cache seed path: fetchPolymarketForGame uses seeded cache (no network)", async () => {
  __clearPolymarketCache();
  __seedPolymarketCache("nhl", nhl);
  const r = await fetchPolymarketForGame(
    "Vegas Golden Knights", "Carolina Hurricanes", "2026-06-09", "away", "nhl",
  );
  assert.equal(r.found, true, r.reason);
  assert.ok(r.pct !== null && Math.abs(r.pct - 50.5) < 0.6, `got ${r.pct}`);
  __clearPolymarketCache();
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
