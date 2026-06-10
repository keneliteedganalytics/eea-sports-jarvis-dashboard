// Integration: POST /api/picks/:id/confirm-bet. Admin-PIN gated, freezes the
// row, second POST is idempotent. Mounts just the route on a throwaway Express
// app against a temp graded book. Run: tsx server/__tests__/confirmBet.test.ts

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graded-confirm-"));
process.env.GRADED_BOOK_PATH = path.join(tmpDir, "test_book.db");
process.env.ADMIN_PIN = "5811";

const { upsertPick, confirmBet, pickId } = await import("../gradedBook");

// Mirror the route + gate from server/routes.ts (kept tiny + self-contained).
const ADMIN_PIN = process.env.ADMIN_PIN || "5811";
const app = express();
app.post("/api/picks/:id/confirm-bet", (req, res) => {
  if (req.header("x-admin-pin") !== ADMIN_PIN) return res.status(401).json({ message: "admin pin required" });
  const frozen = confirmBet(String(req.params.id));
  if (!frozen) return res.status(404).json({ message: "pick not found" });
  res.json(frozen);
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

console.log("POST /api/picks/:id/confirm-bet");

const id = pickId("pitGame1", "ML", "home");
upsertPick({
  gameId: "pitGame1", sport: "mlb", gameDate: "2026-06-08", gameTimeEt: "7:05 PM ET",
  matchup: "CHC @ PIT", homeTeam: "PIT", awayTeam: "CHC",
  homeTeamFull: "Pittsburgh Pirates", awayTeamFull: "Chicago Cubs",
  pickSide: "home", pickTeam: "PIT", pickTeamFull: "Pittsburgh Pirates", pickType: "ML",
  pickLine: null, pickMl: 135, pickBook: "DK", gameStartIso: "2026-06-08T23:05:00Z",
  tier: "EDGE", units: 2, stakeDollars: 600,
  pickWinProb: 0.46, pickImpliedProb: 0.425, edgePp: 3.5, evPer100: 5, confidence: 64, fairMl: 120,
});

await test("401 without the admin pin", async () => {
  const res = await fetch(`${base}/api/picks/${encodeURIComponent(id)}/confirm-bet`, { method: "POST" });
  assert.equal(res.status, 401);
});

await test("404 for an unknown pick id (with pin)", async () => {
  const res = await fetch(`${base}/api/picks/nope:ML:home/confirm-bet`, {
    method: "POST",
    headers: { "x-admin-pin": "5811" },
  });
  assert.equal(res.status, 404);
});

let firstLockedAt = "";
await test("with pin → freezes the row (tier/stake/odds snapshotted)", async () => {
  const res = await fetch(`${base}/api/picks/${encodeURIComponent(id)}/confirm-bet`, {
    method: "POST",
    headers: { "x-admin-pin": "5811" },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.locked, 1);
  assert.equal(body.lockedTier, "EDGE");
  assert.equal(body.lockedStake, 600);
  assert.equal(body.lockedOdds, 135);
  assert.ok(body.lockedAt);
  firstLockedAt = body.lockedAt;
});

await test("second POST is idempotent — same frozen row, lockedAt unchanged", async () => {
  const res = await fetch(`${base}/api/picks/${encodeURIComponent(id)}/confirm-bet`, {
    method: "POST",
    headers: { "x-admin-pin": "5811" },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.locked, 1);
  assert.equal(body.lockedTier, "EDGE");
  assert.equal(body.lockedAt, firstLockedAt, "lockedAt not re-stamped on re-confirm");
});

server.close();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
