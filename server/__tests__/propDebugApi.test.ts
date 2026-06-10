// Integration: GET /api/props/debug (v6.7.1 diagnostic). Mounts a copy of the
// route handler over a temp graded book, seeds an offer + a pick on today's
// operating day, and asserts the JSON shape + that the per-day counts resolve.
// The live events probe is stubbed (no Odds API key in CI → null), matching the
// handler's no-key path. Run: tsx server/__tests__/propDebugApi.test.ts

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graded-prop-debug-"));
process.env.GRADED_BOOK_PATH = path.join(tmpDir, "test_book.db");
// Ensure no key so the events probe returns null deterministically.
delete process.env.ODDS_API_KEY;

const {
  upsertPropOffer,
  upsertPropPick,
  countPropOffersForDate,
  countPropPicksForDate,
} = await import("../gradedBook");
const { getOperatingDay } = await import("../sports/mlb/operatingDay");
const { tomorrowOperatingDay, getLastIngestSummary } = await import("../jobs/propIngest");
const { hasOddsKey, fetchMlbEvents } = await import("../sports/props/ingestMlbProps");

const TODAY = getOperatingDay();
const TOMORROW = tomorrowOperatingDay();

// Seed: one offer + one pick whose game_id matches the offer's event, both on
// today's date. countPropPicksForDate resolves the pick's date via the offer.
upsertPropOffer({
  event_id: "evtToday",
  sport: "mlb",
  game_date: TODAY,
  player_name: "Aaron Judge",
  market: "batter_hits",
  line: 0.5,
  over_price: -120,
  under_price: 100,
  book: "draftkings",
});
upsertPropPick({
  pick_id: "pickToday",
  sport: "mlb",
  game_id: "evtToday",
  player_name: "Aaron Judge",
  market_type: "batter_hits",
  line: 0.5,
  side: "over",
  posted_odds: -120,
});

// Mirror of the real /api/props/debug handler in routes.ts.
const app = express();
app.get("/api/props/debug", async (_req, res) => {
  const today = getOperatingDay();
  const tomorrow = tomorrowOperatingDay();
  let eventsTodayProbe: number | null = null;
  try {
    eventsTodayProbe = hasOddsKey() ? (await fetchMlbEvents(today)).length : null;
  } catch {
    eventsTodayProbe = null;
  }
  res.json({
    today,
    tomorrow,
    hasOddsKey: hasOddsKey(),
    offersToday: countPropOffersForDate(today, "mlb"),
    offersTomorrow: countPropOffersForDate(tomorrow, "mlb"),
    picksToday: countPropPicksForDate(today, "mlb"),
    picksTomorrow: countPropPicksForDate(tomorrow, "mlb"),
    lastIngestSummary: getLastIngestSummary(),
    eventsTodayProbe,
  });
});

const server = app.listen(0);
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;

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

console.log("GET /api/props/debug");

await test("returns the full diagnostic shape with all expected keys", async () => {
  const res = await fetch(`${base}/api/props/debug`);
  assert.equal(res.status, 200);
  const d = await res.json();
  for (const k of [
    "today", "tomorrow", "hasOddsKey", "offersToday", "offersTomorrow",
    "picksToday", "picksTomorrow", "lastIngestSummary", "eventsTodayProbe",
  ]) {
    assert.ok(k in d, `missing key: ${k}`);
  }
});

await test("today / tomorrow are distinct operating-day strings", async () => {
  const d = await (await fetch(`${base}/api/props/debug`)).json();
  assert.equal(d.today, TODAY);
  assert.equal(d.tomorrow, TOMORROW);
  assert.notEqual(d.today, d.tomorrow);
});

await test("offer + pick counts resolve for today, zero for tomorrow", async () => {
  const d = await (await fetch(`${base}/api/props/debug`)).json();
  assert.equal(d.offersToday, 1);
  assert.equal(d.offersTomorrow, 0);
  assert.equal(d.picksToday, 1);
  assert.equal(d.picksTomorrow, 0);
});

await test("no Odds API key → hasOddsKey false, eventsTodayProbe null, summary null", async () => {
  const d = await (await fetch(`${base}/api/props/debug`)).json();
  assert.equal(d.hasOddsKey, false);
  assert.equal(d.eventsTodayProbe, null);
  assert.equal(d.lastIngestSummary, null);
});

server.close();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
