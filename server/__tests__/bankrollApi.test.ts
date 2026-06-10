// Integration: GET /api/bankroll + GET /api/debug/persistence. Mounts tiny
// copies of the route handlers (same as routes.ts) over a temp graded book and
// asserts the JSON shape + that grading moves the numbers. Run:
//   tsx server/__tests__/bankrollApi.test.ts

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graded-bankroll-api-"));
process.env.GRADED_BOOK_PATH = path.join(tmpDir, "test_book.db");
process.env.BANKROLL_USD = "25000";

const {
  getBankrollState,
  gradedDb,
  dbPath,
  pickHistoryCount,
  upsertPick,
  pickId,
  settlePick,
  recordGradeLedger,
} = await import("../gradedBook");

const app = express();
app.get("/api/bankroll", (_req, res) => res.json(getBankrollState()));
app.get("/api/debug/persistence", (_req, res) => {
  const file = dbPath();
  let dbExists = false;
  let dbSizeBytes = 0;
  try {
    const stat = fs.statSync(file);
    dbExists = true;
    dbSizeBytes = stat.size;
  } catch {
    dbExists = false;
  }
  const db = gradedDb();
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>
  ).map((t) => t.name);
  const countFor = (status: string): number =>
    (db.prepare("SELECT COUNT(*) AS n FROM picks WHERE status = ?").get(status) as { n: number }).n;
  const bankroll = getBankrollState();
  res.json({
    dbPath: file,
    dbExists,
    dbSizeBytes,
    tables,
    pickCounts: { pending: countFor("pending"), in_progress: countFor("in_progress"), final: countFor("final") },
    historyCount: pickHistoryCount(),
    bankroll: { starting: bankroll.starting, current: bankroll.current, lastUpdated: bankroll.lastUpdated },
    railwayVolumeMountPath: process.env.RAILWAY_VOLUME_MOUNT_PATH || null,
    gradedBookPathEnv: process.env.GRADED_BOOK_PATH || null,
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

console.log("GET /api/bankroll + /api/debug/persistence");

await test("GET /api/bankroll returns the seeded shape", async () => {
  const res = await fetch(`${base}/api/bankroll`);
  assert.equal(res.status, 200);
  const b = await res.json();
  assert.equal(b.starting, 25000);
  assert.equal(b.current, 25000);
  assert.equal(b.roiPct, 0);
  assert.deepEqual(b.record, { wins: 0, losses: 0, pushes: 0 });
});

await test("GET /api/debug/persistence reports tables + counts + resolved path", async () => {
  const res = await fetch(`${base}/api/debug/persistence`);
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.ok(d.dbPath.endsWith("test_book.db"));
  assert.equal(d.dbExists, true);
  assert.ok(d.dbSizeBytes > 0);
  assert.ok(d.tables.includes("picks"));
  assert.ok(d.tables.includes("bankroll_state"));
  assert.ok(d.tables.includes("pick_history"));
  assert.equal(d.historyCount, 0);
  assert.equal(d.bankroll.starting, 25000);
  assert.equal(d.gradedBookPathEnv, process.env.GRADED_BOOK_PATH);
  assert.equal(d.railwayVolumeMountPath, null);
});

await test("grading a win moves /api/bankroll current + record + roiPct", async () => {
  const id = pickId("apiGame", "ML", "away");
  upsertPick({
    gameId: "apiGame", sport: "mlb", gameDate: "2026-06-09", gameTimeEt: "7:05 PM ET",
    matchup: "AAA @ BBB", homeTeam: "BBB", awayTeam: "AAA",
    homeTeamFull: "B", awayTeamFull: "A",
    pickSide: "away", pickTeam: "AAA", pickTeamFull: "A", pickType: "ML",
    pickLine: null, pickMl: 100, pickBook: "DK", gameStartIso: "2026-06-09T23:05:00Z",
    tier: "SNIPER", units: 1, stakeDollars: 1000,
    pickWinProb: 0.5, pickImpliedProb: 0.5, edgePp: 0, evPer100: 0, confidence: 60, fairMl: 100,
  });
  settlePick(id, { finalAwayScore: 5, finalHomeScore: 2, result: "W", pl: 1, clvPct: null, liveStatusDetail: "Final" });
  recordGradeLedger(id);

  const res = await fetch(`${base}/api/bankroll`);
  const b = await res.json();
  assert.equal(b.current, 26000);
  assert.equal(b.record.wins, 1);
  assert.equal(b.netDollars, 1000);
  assert.equal(b.roiPct, 4);
});

await test("persistence endpoint reflects the new final + history row", async () => {
  const res = await fetch(`${base}/api/debug/persistence`);
  const d = await res.json();
  assert.equal(d.pickCounts.final, 1);
  assert.equal(d.historyCount, 1);
  assert.equal(d.bankroll.current, 26000);
  assert.ok(d.bankroll.lastUpdated);
});

server.close();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
