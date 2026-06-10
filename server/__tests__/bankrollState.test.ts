// bankroll_state: init from BANKROLL_USD, and W/L/P deltas applied on grade.
// Runs against a throwaway graded book. Run: tsx server/__tests__/bankrollState.test.ts

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graded-bankroll-"));
process.env.GRADED_BOOK_PATH = path.join(tmpDir, "test_book.db");
process.env.BANKROLL_USD = "25000";

const { gradedDb, getBankrollState, applyGradeToBankroll, upsertPick, pickId, settlePick, recordGradeLedger } =
  await import("../gradedBook");

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

console.log("bankroll_state");

await test("initializes from BANKROLL_USD on first boot", () => {
  const s = getBankrollState();
  assert.equal(s.starting, 25000);
  assert.equal(s.current, 25000);
  assert.equal(s.record.wins, 0);
  assert.equal(s.record.losses, 0);
  assert.equal(s.record.pushes, 0);
  assert.equal(s.netDollars, 0);
});

await test("W: current += stake × (decimal − 1), wins++ , net up", () => {
  const db = gradedDb();
  // +150 → decimal 2.5 → win pays 1.5× stake. stake $1000 → +$1500.
  applyGradeToBankroll(db, { result: "W", stakeDollars: 1000, plUnits: 1.5, americanOdds: 150 });
  const s = getBankrollState();
  assert.equal(s.current, 26500);
  assert.equal(s.record.wins, 1);
  assert.equal(s.netDollars, 1500);
  assert.equal(s.netUnits, 1.5);
});

await test("L: current −= stake, losses++, net down", () => {
  const db = gradedDb();
  applyGradeToBankroll(db, { result: "L", stakeDollars: 1000, plUnits: -1, americanOdds: -110 });
  const s = getBankrollState();
  assert.equal(s.current, 25500);
  assert.equal(s.record.losses, 1);
  assert.equal(s.netDollars, 500);
  assert.equal(s.netUnits, 0.5);
});

await test("P: no bankroll change, pushes++", () => {
  const db = gradedDb();
  const before = getBankrollState();
  applyGradeToBankroll(db, { result: "P", stakeDollars: 1000, plUnits: 0, americanOdds: 120 });
  const s = getBankrollState();
  assert.equal(s.current, before.current);
  assert.equal(s.record.pushes, 1);
  assert.equal(s.netDollars, before.netDollars);
});

await test("negative-odds win pays 100/|odds| × stake", () => {
  const db = gradedDb();
  const before = getBankrollState();
  // -200 → decimal 1.5 → win pays 0.5× stake. stake $400 → +$200.
  applyGradeToBankroll(db, { result: "W", stakeDollars: 400, plUnits: 0.5, americanOdds: -200 });
  const s = getBankrollState();
  assert.equal(s.current, before.current + 200);
  assert.equal(s.record.wins, 2);
});

await test("roiPct = lifetime net dollars over starting bankroll", () => {
  const s = getBankrollState();
  // net = 1500 - 1000 + 200 = 700 on 25000 → 2.8%
  assert.equal(s.netDollars, 700);
  assert.equal(s.roiPct, 2.8);
});

await test("recordGradeLedger drives the bankroll once on settle", () => {
  const id = pickId("brkGame", "ML", "home");
  upsertPick({
    gameId: "brkGame", sport: "mlb", gameDate: "2026-06-09", gameTimeEt: "7:05 PM ET",
    matchup: "NYM @ BRK", homeTeam: "BRK", awayTeam: "NYM",
    homeTeamFull: "Brooklyn", awayTeamFull: "New York Mets",
    pickSide: "home", pickTeam: "BRK", pickTeamFull: "Brooklyn", pickType: "ML",
    pickLine: null, pickMl: 100, pickBook: "DK", gameStartIso: "2026-06-09T23:05:00Z",
    tier: "EDGE", units: 1, stakeDollars: 500,
    pickWinProb: 0.5, pickImpliedProb: 0.5, edgePp: 0, evPer100: 0, confidence: 60, fairMl: 100,
  });
  settlePick(id, { finalAwayScore: 1, finalHomeScore: 3, result: "W", pl: 1, clvPct: null, liveStatusDetail: "Final" });
  const before = getBankrollState();
  recordGradeLedger(id);
  const after1 = getBankrollState();
  // +100 → decimal 2.0 → win pays 1× $500 = +$500.
  assert.equal(after1.current, before.current + 500);
  assert.equal(after1.record.wins, before.record.wins + 1);
  // Idempotent: a second call must NOT re-apply the bankroll delta.
  recordGradeLedger(id);
  const after2 = getBankrollState();
  assert.equal(after2.current, after1.current);
  assert.equal(after2.record.wins, after1.record.wins);
});

await test("lastUpdated is stamped once a grade is applied", () => {
  const s = getBankrollState();
  assert.ok(s.lastUpdated, "lastUpdated set after grades");
  assert.ok(!Number.isNaN(Date.parse(s.lastUpdated!)), "lastUpdated is an ISO timestamp");
});

await test("a fresh boot with no env falls back to the 25000 default", async () => {
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "graded-bankroll-default-"));
  const prevPath = process.env.GRADED_BOOK_PATH;
  const prevEnv = process.env.BANKROLL_USD;
  delete process.env.BANKROLL_USD;
  process.env.GRADED_BOOK_PATH = path.join(tmp2, "book.db");
  // Re-import a fresh module instance so the singleton DB re-resolves the path.
  const mod = await import(`../gradedBook?default-bankroll-test`);
  const s = (mod as typeof import("../gradedBook")).getBankrollState();
  assert.equal(s.starting, 25000);
  assert.equal(s.current, 25000);
  process.env.GRADED_BOOK_PATH = prevPath;
  if (prevEnv !== undefined) process.env.BANKROLL_USD = prevEnv;
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
