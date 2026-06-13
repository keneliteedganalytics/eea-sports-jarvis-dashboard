// Integration: GET /api/debug/dates (v6.7.8 diagnostic). Mounts a copy of the
// route handler and asserts the JSON shape + that the operating-day values are
// internally consistent (tomorrow = opDay+1, yesterday = opDay-1) and anchored
// to DISPLAY_TIMEZONE. Run: tsx server/__tests__/debugDatesApi.test.ts

import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import {
  getOperatingDay,
  tomorrowOperatingDay,
  yesterdayOperatingDay,
} from "../sports/mlb/operatingDay";
import { DISPLAY_TIMEZONE } from "../utils/timezone";

// Mirror of the real /api/debug/dates handler in routes.ts.
const app = express();
app.get("/api/debug/dates", (_req, res) => {
  res.json({
    serverUtc: new Date().toISOString(),
    displayTimezone: DISPLAY_TIMEZONE,
    operatingDay: getOperatingDay(),
    tomorrowOperatingDay: tomorrowOperatingDay(),
    yesterdayOperatingDay: yesterdayOperatingDay(),
  });
});

const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

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

console.log("GET /api/debug/dates");

await test("returns the full diagnostic shape with all expected keys", async () => {
  const res = await fetch(`${base}/api/debug/dates`);
  assert.equal(res.status, 200);
  const d = await res.json();
  for (const k of [
    "serverUtc", "displayTimezone", "operatingDay",
    "tomorrowOperatingDay", "yesterdayOperatingDay",
  ]) {
    assert.ok(k in d, `missing key: ${k}`);
  }
});

await test("displayTimezone defaults to America/New_York", async () => {
  const d = await (await fetch(`${base}/api/debug/dates`)).json();
  assert.equal(d.displayTimezone, "America/New_York");
});

await test("operatingDay is a YYYY-MM-DD string and serverUtc is ISO", async () => {
  const d = await (await fetch(`${base}/api/debug/dates`)).json();
  assert.match(d.operatingDay, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(!Number.isNaN(Date.parse(d.serverUtc)));
});

await test("tomorrow = opDay + 1 day, yesterday = opDay - 1 day", async () => {
  const d = await (await fetch(`${base}/api/debug/dates`)).json();
  const plus = (iso: string, days: number) => {
    const x = new Date(`${iso}T12:00:00Z`);
    x.setUTCDate(x.getUTCDate() + days);
    return x.toISOString().slice(0, 10);
  };
  assert.equal(d.tomorrowOperatingDay, plus(d.operatingDay, 1));
  assert.equal(d.yesterdayOperatingDay, plus(d.operatingDay, -1));
});

server.close();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
