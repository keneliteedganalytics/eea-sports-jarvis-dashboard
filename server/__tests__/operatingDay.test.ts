// Operating-day timezone correctness (v6.7.8). The "dates off by a day" bug
// came from formatting/boundary logic that didn't anchor to DISPLAY_TIMEZONE.
// These tests pin the canonical behavior at the default zone (America/New_York,
// EDT in June): the operating day is the ET civil date with a 6 AM rollover,
// NOT the UTC date. Run: tsx server/__tests__/operatingDay.test.ts

import assert from "node:assert/strict";
import {
  getOperatingDay,
  tomorrowOperatingDay,
  yesterdayOperatingDay,
  utcIsoToEtClock,
} from "../sports/mlb/operatingDay";

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err as Error).message}`);
  }
}

console.log("operating day — v6.7.8 (DISPLAY_TIMEZONE, default ET)");

// --- getOperatingDay boundary behavior (EDT = UTC-4 in June) ---

test("11 PM ET (UTC already next day) stays on the prior ET date", () => {
  // 2026-06-14T03:00:00Z = 23:00 EDT June 13. UTC says the 14th; ET says the 13th.
  assert.equal(getOperatingDay(new Date("2026-06-14T03:00:00Z")), "2026-06-13");
});

test("5 AM ET (pre-6AM boundary) is still the prior operating day", () => {
  // 2026-06-14T09:00:00Z = 05:00 EDT June 14, before the 6 AM rollover.
  assert.equal(getOperatingDay(new Date("2026-06-14T09:00:00Z")), "2026-06-13");
});

test("7 AM ET (past 6AM boundary) rolls to the new operating day", () => {
  // 2026-06-14T11:00:00Z = 07:00 EDT June 14, past the 6 AM rollover.
  assert.equal(getOperatingDay(new Date("2026-06-14T11:00:00Z")), "2026-06-14");
});

test("the UTC-bug instant (1 AM UTC = 9 PM ET prior day) yields the ET date", () => {
  // The classic off-by-one: .toISOString().slice(0,10) would return 2026-06-14,
  // but the ET civil date — what the user sees — is 2026-06-13.
  const instant = new Date("2026-06-14T01:00:00Z");
  assert.notEqual(instant.toISOString().slice(0, 10), getOperatingDay(instant));
  assert.equal(getOperatingDay(instant), "2026-06-13");
});

// --- tomorrow / yesterday helpers ---

test("tomorrow/yesterday wrap a normal day", () => {
  const now = new Date("2026-06-14T03:00:00Z"); // opDay 2026-06-13
  assert.equal(getOperatingDay(now), "2026-06-13");
  assert.equal(tomorrowOperatingDay(now), "2026-06-14");
  assert.equal(yesterdayOperatingDay(now), "2026-06-12");
});

test("tomorrow crosses a month boundary", () => {
  const now = new Date("2026-07-01T03:00:00Z"); // 23:00 EDT June 30 → opDay 2026-06-30
  assert.equal(getOperatingDay(now), "2026-06-30");
  assert.equal(tomorrowOperatingDay(now), "2026-07-01");
});

test("yesterday crosses a year boundary", () => {
  // 2026-01-01T12:00:00Z = 07:00 EST Jan 1 (past boundary) → opDay 2026-01-01
  const now = new Date("2026-01-01T12:00:00Z");
  assert.equal(getOperatingDay(now), "2026-01-01");
  assert.equal(yesterdayOperatingDay(now), "2025-12-31");
});

test("tomorrow crosses a year boundary", () => {
  const now = new Date("2026-12-31T18:00:00Z"); // 13:00 EST Dec 31 → opDay 2026-12-31
  assert.equal(getOperatingDay(now), "2026-12-31");
  assert.equal(tomorrowOperatingDay(now), "2027-01-01");
});

// --- clock formatter ---

test("utcIsoToEtClock renders the ET wall clock with the ET wordmark", () => {
  // 2026-06-14T01:00:00Z = 21:00 EDT June 13.
  assert.equal(utcIsoToEtClock("2026-06-14T01:00:00Z"), "9:00 PM ET");
});

test("utcIsoToEtClock follows the EST offset in winter (UTC-5)", () => {
  // 2026-01-15T01:00:00Z = 20:00 EST Jan 14 (UTC-5, standard time).
  assert.equal(utcIsoToEtClock("2026-01-15T01:00:00Z"), "8:00 PM ET");
});

test("utcIsoToEtClock is empty for malformed input", () => {
  assert.equal(utcIsoToEtClock("not-a-date"), "");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
