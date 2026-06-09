// Bet lock-in. A confirmed (locked) pick must survive a slate recompute with its
// tier/stake/odds frozen. Covers: pickLockGuard purity, upsertPick refusing to
// re-tier a locked row, confirmBet snapshot + idempotency, and the read-time
// overlay that makes analytics show the LOCKED values.
// Uses a throwaway DB via GRADED_BOOK_PATH. Run: tsx server/__tests__/pickLock.test.ts

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graded-lock-"));
process.env.GRADED_BOOK_PATH = path.join(tmpDir, "test_book.db");

const { upsertPick, getPick, confirmBet, pickLockGuard, pickId, gradedPicks, gradedDb } = await import("../gradedBook");

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

console.log("pick lock-in");

const BASE = {
  gameId: "pitGame1", sport: "mlb", gameDate: "2026-06-08", gameTimeEt: "7:05 PM ET",
  matchup: "CHC @ PIT", homeTeam: "PIT", awayTeam: "CHC",
  homeTeamFull: "Pittsburgh Pirates", awayTeamFull: "Chicago Cubs",
  pickSide: "home", pickTeam: "PIT", pickTeamFull: "Pittsburgh Pirates", pickType: "ML",
  pickLine: null, pickMl: 135, pickBook: "DK",
  pickWinProb: 0.46, pickImpliedProb: 0.425, edgePp: 3.5, evPer100: 5, confidence: 64, fairMl: 120,
};

const id = pickId("pitGame1", "ML", "home");

// ── pickLockGuard purity ────────────────────────────────────────────
test("pickLockGuard reports locked + returns the same pick reference", () => {
  const unlocked = { locked: 0 as const, tier: "EDGE" };
  const locked = { locked: 1 as const, tier: "SNIPER" };
  assert.equal(pickLockGuard(unlocked).locked, false);
  assert.equal(pickLockGuard(locked).locked, true);
  assert.equal(pickLockGuard(locked).pick, locked);
});

// ── confirmBet snapshots current tier/stake/odds ────────────────────
test("confirmBet freezes tier/stake/odds and sets lockedAt", () => {
  upsertPick({ ...BASE, tier: "SNIPER", units: 3, stakeDollars: 900 });
  assert.equal(getPick(id)!.locked, 0);
  const frozen = confirmBet(id)!;
  assert.equal(frozen.locked, 1);
  assert.equal(frozen.lockedTier, "SNIPER");
  assert.equal(frozen.lockedStake, 900);
  assert.equal(frozen.lockedOdds, 135);
  assert.ok(frozen.lockedAt, "lockedAt set");
});

// ── upsertPick (the recompute chokepoint) must not re-tier a locked row ──
test("a slate recompute can NOT re-tier a locked pick (the Pirates bug)", () => {
  // Simulate the downstream recompute trying to clobber the pick to PASS/no-play.
  const wrote = upsertPick({ ...BASE, tier: "PASS", units: 0, stakeDollars: 0, pickMl: -110 });
  assert.equal(wrote, false, "upsertPick should refuse to write a locked row");
  const row = getPick(id)!;
  assert.equal(row.tier, "SNIPER", "tier stayed frozen");
  assert.equal(row.stakeDollars, 900, "stake stayed frozen");
  assert.equal(row.pickMl, 135, "odds stayed frozen");
});

// ── idempotency ─────────────────────────────────────────────────────
test("confirmBet is idempotent — second call returns the same frozen row", () => {
  const first = getPick(id)!;
  const second = confirmBet(id)!;
  assert.equal(second.locked, 1);
  assert.equal(second.lockedTier, first.lockedTier);
  assert.equal(second.lockedStake, first.lockedStake);
  assert.equal(second.lockedAt, first.lockedAt, "lockedAt not re-stamped");
});

// ── analytics read overlay: locked rows present the LOCKED tier/stake ──
test("gradedPicks shows the LOCKED tier/stake even if raw columns drift", () => {
  // Force the raw tier/stake to a recomputed value behind the lock, then verify
  // the read overlay still surfaces the locked snapshot.
  gradedDb().prepare("UPDATE picks SET status='final', tier='PASS', stakeDollars=0, result='W', pl=2 WHERE id=?").run(id);
  const rows = gradedPicks("MLB");
  const r = rows.find((x) => x.id === id)!;
  assert.equal(r.tier, "SNIPER", "analytics shows locked tier, not recomputed PASS");
  assert.equal(r.stakeDollars, 900, "analytics shows locked stake");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
