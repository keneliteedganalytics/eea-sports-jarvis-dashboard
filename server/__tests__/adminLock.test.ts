// Integration: POST /api/picks/:id/admin-lock. Admin-PIN gated (403 on miss),
// overrides tier/odds/stake on the raw row, then snapshot+locks via confirmBet,
// and writes a pick_audit row. Mounts just the route on a throwaway Express app
// against a temp graded book. Run: tsx server/__tests__/adminLock.test.ts

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { z } from "zod";
import type { AddressInfo } from "node:net";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graded-adminlock-"));
process.env.GRADED_BOOK_PATH = path.join(tmpDir, "test_book.db");
process.env.ADMIN_PIN = "5811";

const { upsertPick, adminLockWithOverride, gradedDb, pickId } = await import("../gradedBook");
import type { SeedBuiltPick, SeedLookup } from "../gradedBook";

// Mirror the route + gate from server/routes.ts (kept tiny + self-contained).
const ADMIN_PIN = process.env.ADMIN_PIN || "5811";
const adminLockBody = z.object({
  tier: z.enum(["SNIPER", "EDGE", "DUAL", "RECON", "PASS"]),
  odds: z.number().optional(),
  stake: z.number().optional(),
  reason: z.string().min(1),
  seedFromLive: z.boolean().optional(),
});

// Stub the live slate engine, mirroring defaultSeedLookup's contract exactly: the
// real getAnyPick matches BuiltPick.gameId (not the composite id), so the resolver
// must split the composite id, look up by bare gameId, and reject when the
// returned pick's market (pickType/pickSide) doesn't match the requested id parts.
const livePicks = new Map<string, SeedBuiltPick>();
let lastSeedGameId: string | null = null;
const seedLookup: SeedLookup = async (id) => {
  const [gameId, pickType, pickSide] = id.split(":");
  lastSeedGameId = gameId;
  const pick = livePicks.get(gameId);
  if (!pick || pick.pickType !== pickType || pick.pickSide !== pickSide) return null;
  return pick;
};

const app = express();
app.use(express.json());
app.post("/api/picks/:id/admin-lock", async (req, res) => {
  if (req.header("x-admin-pin") !== ADMIN_PIN) return res.status(403).json({ message: "admin pin required" });
  const parsed = adminLockBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "invalid body", issues: parsed.error.issues });
  const result = await adminLockWithOverride(String(req.params.id), parsed.data, seedLookup);
  if (!result) return res.status(404).json({ message: "pick not found" });
  res.json(result);
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

console.log("POST /api/picks/:id/admin-lock");

// Seed the Pirates pick, then simulate the recompute clobber: stored tier is now
// RECON at -150, but the original locked-in bet was EDGE at -110.
const id = pickId("pitGame1", "ML", "home");
upsertPick({
  gameId: "pitGame1", sport: "mlb", gameDate: "2026-06-08", gameTimeEt: "7:05 PM ET",
  matchup: "CHC @ PIT", homeTeam: "PIT", awayTeam: "CHC",
  homeTeamFull: "Pittsburgh Pirates", awayTeamFull: "Chicago Cubs",
  pickSide: "home", pickTeam: "PIT", pickTeamFull: "Pittsburgh Pirates", pickType: "ML",
  pickLine: null, pickMl: -150, pickBook: "DK", tier: "RECON", units: 1, stakeDollars: 300,
  pickWinProb: 0.46, pickImpliedProb: 0.425, edgePp: 3.5, evPer100: 5, confidence: 64, fairMl: 120,
});

await test("403 without the admin pin", async () => {
  const res = await fetch(`${base}/api/picks/${encodeURIComponent(id)}/admin-lock`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tier: "EDGE", odds: -110, reason: "original bet was EDGE -110" }),
  });
  assert.equal(res.status, 403);
});

await test("404 for an unknown pick id (with pin)", async () => {
  const res = await fetch(`${base}/api/picks/nope:ML:home/admin-lock`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-pin": "5811" },
    body: JSON.stringify({ tier: "EDGE", odds: -110, reason: "no such pick" }),
  });
  assert.equal(res.status, 404);
});

await test("with pin → overrides tier/odds, locks the row, writes an audit row", async () => {
  const res = await fetch(`${base}/api/picks/${encodeURIComponent(id)}/admin-lock`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-pin": "5811" },
    body: JSON.stringify({ tier: "EDGE", odds: -110, reason: "original bet was EDGE -110" }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();

  // Frozen row reflects the override.
  assert.equal(body.pick.locked, 1);
  assert.equal(body.pick.lockedTier, "EDGE");
  assert.equal(body.pick.lockedOdds, -110);
  assert.ok(body.pick.lockedAt);

  // Audit row records the before → after transition.
  assert.equal(body.audit.pickId, id);
  assert.equal(body.audit.action, "admin-lock");
  assert.equal(body.audit.fromTier, "RECON");
  assert.equal(body.audit.toTier, "EDGE");
  assert.equal(body.audit.fromOdds, -150);
  assert.equal(body.audit.toOdds, -110);
  assert.equal(body.audit.reason, "original bet was EDGE -110");
  assert.ok(body.audit.createdAt);

  // The audit row is actually persisted.
  const rows = gradedDb().prepare("SELECT * FROM pick_audit WHERE pickId = ?").all(id) as Array<{ toTier: string }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].toTier, "EDGE");
});

await test("missing id + seedFromLive omitted → still 404 (no behavior change)", async () => {
  const res = await fetch(`${base}/api/picks/wasGame1:ML:away/admin-lock`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-pin": "5811" },
    body: JSON.stringify({ tier: "EDGE", odds: -110, reason: "no seed" }),
  });
  assert.equal(res.status, 404);
  // Nothing inserted.
  const row = gradedDb().prepare("SELECT * FROM picks WHERE id = ?").get("wasGame1:ML:away");
  assert.equal(row, undefined);
});

await test("missing id + seedFromLive=true → hydrates from live, inserts with override, locks, audits", async () => {
  const seedId = pickId("wasGame1", "ML", "away");
  // The live engine now scores this PASS at 0 units, so persistPicks never wrote
  // it. The original locked-in bet was DUAL at +120. Keyed by bare gameId, matching
  // the real getAnyPick contract.
  livePicks.set("wasGame1", {
    gameId: "wasGame1", sport: "mlb", gameDate: "2026-06-09", gameTimeEt: "7:05 PM ET",
    matchup: "WSH @ NYM", homeTeam: "NYM", awayTeam: "WSH",
    homeTeamFull: "New York Mets", awayTeamFull: "Washington Nationals",
    pickSide: "away", pickTeam: "WSH", pickTeamFull: "Washington Nationals", pickType: "ML",
    pickMl: 130, pickBook: "FD", verdictTier: "PASS", units: 0, kellyStakeDollars: 0,
    pickWinProb: 0.44, pickImpliedProb: 0.435, edgePp: 0.5, evPer100: 1, confidence: 51, fairMl: 125,
  });

  const res = await fetch(`${base}/api/picks/${encodeURIComponent(seedId)}/admin-lock`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-pin": "5811" },
    body: JSON.stringify({ tier: "DUAL", odds: 120, stake: 150, seedFromLive: true, reason: "original bet was DUAL +120" }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();

  // The resolver parsed the composite id and looked up by the bare gameId.
  assert.equal(lastSeedGameId, "wasGame1");

  // Row was inserted and locked with the override applied on top of live values.
  assert.equal(body.pick.locked, 1);
  assert.equal(body.pick.tier, "DUAL");
  assert.equal(body.pick.lockedTier, "DUAL");
  assert.equal(body.pick.lockedOdds, 120);
  assert.equal(body.pick.lockedStake, 150);
  assert.equal(body.pick.pickType, "ML");
  assert.equal(body.pick.pickLine, null);
  assert.ok(body.pick.lockedAt);

  // Audit row written for the seeded lock.
  assert.equal(body.audit.pickId, seedId);
  assert.equal(body.audit.action, "admin-lock");
  assert.equal(body.audit.toTier, "DUAL");
  assert.equal(body.audit.reason, "original bet was DUAL +120");

  // Row actually persisted in the book.
  const row = gradedDb().prepare("SELECT * FROM picks WHERE id = ?").get(seedId) as { tier: string; locked: number; pickLine: number | null };
  assert.equal(row.tier, "DUAL");
  assert.equal(row.locked, 1);
  assert.equal(row.pickLine, null);
});

await test("seedFromLive=true but live pick's market mismatches the id → 404", async () => {
  // The slate has a live pick for this game, but on the home/ML market. Requesting
  // the away side must not silently lock the wrong market — resolver returns null.
  livePicks.set("balGame1", {
    gameId: "balGame1", sport: "mlb", gameDate: "2026-06-09", gameTimeEt: "7:05 PM ET",
    matchup: "BAL @ TOR", homeTeam: "TOR", awayTeam: "BAL",
    homeTeamFull: "Toronto Blue Jays", awayTeamFull: "Baltimore Orioles",
    pickSide: "home", pickTeam: "TOR", pickTeamFull: "Toronto Blue Jays", pickType: "ML",
    pickMl: -120, pickBook: "FD", verdictTier: "EDGE", units: 1, kellyStakeDollars: 200,
    pickWinProb: 0.55, pickImpliedProb: 0.545, edgePp: 0.5, evPer100: 1, confidence: 60, fairMl: -130,
  });
  const mismatchId = pickId("balGame1", "ML", "away");
  const res = await fetch(`${base}/api/picks/${encodeURIComponent(mismatchId)}/admin-lock`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-pin": "5811" },
    body: JSON.stringify({ tier: "EDGE", odds: -110, seedFromLive: true, reason: "wrong market" }),
  });
  assert.equal(res.status, 404);
  // Nothing inserted for the mismatched market.
  const row = gradedDb().prepare("SELECT * FROM picks WHERE id = ?").get(mismatchId);
  assert.equal(row, undefined);
});

await test("400 when the body is invalid (bad tier)", async () => {
  const res = await fetch(`${base}/api/picks/${encodeURIComponent(id)}/admin-lock`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-pin": "5811" },
    body: JSON.stringify({ tier: "GOLD", reason: "nope" }),
  });
  assert.equal(res.status, 400);
});

server.close();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
