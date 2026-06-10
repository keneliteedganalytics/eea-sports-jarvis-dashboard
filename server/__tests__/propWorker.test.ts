// Prop-ingest worker day-routing (v6.7.1 hotfix). The worker must fire a full
// ingest+build cycle for BOTH today and tomorrow on every tick — not just
// tomorrow, which left today's (live/imminent) slate empty all day. We inject
// mock ingest/build deps and assert runBothCycles calls each exactly twice, with
// the two distinct operating-day strings, today before tomorrow.
// Run: tsx server/__tests__/propWorker.test.ts

import assert from "node:assert/strict";
import { runBothCycles, tomorrowOperatingDay } from "../jobs/propIngest";
import { getOperatingDay } from "../sports/mlb/operatingDay";

let passed = 0;
let failed = 0;
async function testAsync(name: string, fn: () => Promise<void>) {
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

// Noon UTC on a fixed date → past the 6 AM ET boundary, so the operating day is
// that calendar date. Gives deterministic today/tomorrow strings.
const NOW = new Date("2026-06-10T12:00:00Z");
const TODAY = getOperatingDay(NOW);
const TOMORROW = tomorrowOperatingDay(NOW);

console.log("prop-ingest worker — fires both today and tomorrow");

await testAsync("runBothCycles ingests + builds today AND tomorrow (distinct dates)", async () => {
  const ingestDates: string[] = [];
  const buildDates: string[] = [];
  const deps = {
    ingest: async (date: string) => {
      ingestDates.push(date);
      return { date, events: 1, offers: 5 };
    },
    build: async (date: string) => {
      buildDates.push(date);
      return { date, considered: 3, written: 2, pickIds: ["a", "b"] };
    },
  };

  const summary = await runBothCycles(NOW, deps);

  // Each adapter called exactly twice — once per day.
  assert.equal(ingestDates.length, 2, "ingest should be called twice");
  assert.equal(buildDates.length, 2, "build should be called twice");

  // The two distinct operating days, today first.
  assert.deepEqual(ingestDates, [TODAY, TOMORROW]);
  assert.deepEqual(buildDates, [TODAY, TOMORROW]);
  assert.notEqual(TODAY, TOMORROW);

  // Summary reflects both days.
  assert.equal(summary.today.date, TODAY);
  assert.equal(summary.tomorrow.date, TOMORROW);
  assert.equal(summary.today.offers, 5);
  assert.equal(summary.tomorrow.written, 2);
  assert.ok(typeof summary.ranAt === "string" && summary.ranAt.length > 0);
});

await testAsync("a failure on one day never blocks the other", async () => {
  const buildDates: string[] = [];
  const deps = {
    ingest: async (date: string) => {
      if (date === TODAY) throw new Error("today ingest blew up");
      return { date, events: 1, offers: 7 };
    },
    build: async (date: string) => {
      buildDates.push(date);
      return { date, considered: 1, written: 1, pickIds: ["x"] };
    },
  };

  const summary = await runBothCycles(NOW, deps);

  // Today's ingest threw → its cycle degrades to zero offers, but tomorrow still
  // ran its full cycle. Build is still attempted for both days.
  assert.deepEqual(buildDates, [TODAY, TOMORROW]);
  assert.equal(summary.today.offers, 0);
  assert.equal(summary.tomorrow.offers, 7);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
