// v6.14.0 — card + health endpoints. Mounts tiny copies of the /api/card/today,
// /api/card/:date and /api/health handlers (same logic as routes.ts) over a
// scratch data.db and asserts the JSON contracts the home page + health probe
// depend on. Run: tsx server/__tests__/endpoints.test.ts

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";
import type { BuiltPick } from "../sports/mlb/picksEngine";
import type { Market } from "../core/types";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "card-endpoints-"));
process.chdir(tmpDir);

const { lockDailyCard, getCard, getTodayCard } = await import("../core/dailyCard");
const { getOperatingDay } = await import("../sports/mlb/operatingDay");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function parseDateParam(raw: unknown): string | undefined {
  return typeof raw === "string" && DATE_RE.test(raw) ? raw : undefined;
}

function mlMkt(edge: number): Market {
  return { available: true, pick: "AAA ML", line: null, priceAmerican: -150, fairLine: -200, edgePp: edge, tier: "EDGE", units: 1, side: "home", book: "draftkings" };
}
function emptyMkt(): Market {
  return { available: false, pick: null, line: null, priceAmerican: null, fairLine: null, edgePp: null, tier: "PASS", units: 0, side: null, book: null };
}
let gid = 0;
function mkPick(edge: number): BuiltPick {
  const id = `g${gid++}`;
  return {
    verdict: "PLAY", gameId: id, gameDate: "x", gameTimeEt: "7:05 PM ET", gameStartIso: null,
    matchup: `AAA @ BBB ${id}`, homeTeam: "BBB", awayTeam: "AAA", pickTeam: "AAA", pickWinProb: 0.6,
    markets: { ml: mlMkt(edge), spread: emptyMkt(), total: emptyMkt() },
  } as unknown as BuiltPick;
}

// Lock today's operating-day card so /api/card/today has data.
const today = getOperatingDay(new Date());
lockDailyCard(today, [9, 8, 7].map(mkPick), 25000);

const app = express();
app.get("/api/card/today", (_req, res) => {
  const cardDate = getOperatingDay(new Date());
  const card = getTodayCard();
  if (!card) return res.json({ cardDate, locked: false, picks: [], parlays: [], passReason: null });
  res.json({ ...card, locked: true });
});
app.get("/api/card/:date", (req, res) => {
  const date = parseDateParam(req.params.date);
  if (!date) return res.status(400).json({ message: "date must be YYYY-MM-DD" });
  const card = getCard(date);
  if (!card) return res.json({ cardDate: date, locked: false, picks: [], parlays: [], passReason: null });
  res.json({ ...card, locked: true });
});
app.get("/api/health", (_req, res) => {
  let dbHealthy = true;
  let lastCardLocked: string | null = null;
  let cardPickCount = 0;
  try {
    const card = getTodayCard();
    lastCardLocked = card?.lockedAt ?? null;
    cardPickCount = card?.picks.length ?? 0;
  } catch {
    dbHealthy = false;
  }
  res.json({
    version: "6.14.0",
    uptime: Math.round(process.uptime()),
    feeds: { mlbStats: true, savant: true, oddsApi: false, openWeather: false, apiSports: false },
    lastCardLocked,
    cardPickCount,
    dbHealthy,
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

console.log("endpoints — v6.14.0 /api/card + /api/health");

await test("GET /api/card/today returns the locked card", async () => {
  const res = await fetch(`${base}/api/card/today`);
  assert.equal(res.status, 200);
  const c = await res.json();
  assert.equal(c.locked, true);
  assert.equal(c.cardDate, today);
  assert.equal(c.picks.length, 3);
  assert.ok(c.lockedAt);
  assert.ok(Array.isArray(c.parlays));
});

await test("GET /api/card/:date returns the same locked card", async () => {
  const res = await fetch(`${base}/api/card/${today}`);
  assert.equal(res.status, 200);
  const c = await res.json();
  assert.equal(c.locked, true);
  assert.equal(c.picks.length, 3);
});

await test("GET /api/card/:date rejects a malformed date", async () => {
  const res = await fetch(`${base}/api/card/notadate`);
  assert.equal(res.status, 400);
});

await test("GET /api/card/:date returns unlocked for an unknown date", async () => {
  const res = await fetch(`${base}/api/card/2020-01-01`);
  assert.equal(res.status, 200);
  const c = await res.json();
  assert.equal(c.locked, false);
  assert.equal(c.picks.length, 0);
});

await test("GET /api/health returns the health contract", async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  const h = await res.json();
  assert.equal(h.version, "6.14.0");
  assert.equal(typeof h.uptime, "number");
  assert.equal(h.dbHealthy, true);
  assert.equal(h.cardPickCount, 3);
  assert.ok(h.lastCardLocked);
  assert.equal(h.feeds.mlbStats, true);
  assert.equal(typeof h.feeds.oddsApi, "boolean");
});

server.close();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
