// v6.10 — F5 grading tests.
// Tests: F5 run summing, 5th-inning completion detection, and gradeF5Pick logic.
// Run: tsx server/__tests__/f5Grading.test.ts

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Set up a temp DB before importing gradedBook
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "f5grade-"));
process.env.GRADED_BOOK_PATH = path.join(tmpDir, "f5_test.db");

// Dynamic imports
const { sumF5Runs, isFifthInningComplete, gradeF5Pick } = await import("../jobs/liveScoring");
const { gradedDb, upsertF5Pick, f5PickId, getF5PicksForDate } = await import("../gradedBook");

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

console.log("v6.10 — F5 grading");

// ── sumF5Runs tests ──────────────────────────────────────────────────

test("sumF5Runs: 5 complete innings", () => {
  const innings = [
    { home: { runs: 2 }, away: { runs: 0 } },
    { home: { runs: 0 }, away: { runs: 1 } },
    { home: { runs: 1 }, away: { runs: 0 } },
    { home: { runs: 0 }, away: { runs: 0 } },
    { home: { runs: 3 }, away: { runs: 2 } },
  ];
  assert.equal(sumF5Runs(innings, "home"), 6);
  assert.equal(sumF5Runs(innings, "away"), 3);
});

test("sumF5Runs: only counts first 5 innings even if more are present", () => {
  const innings = [
    { home: { runs: 1 }, away: { runs: 0 } },
    { home: { runs: 0 }, away: { runs: 0 } },
    { home: { runs: 0 }, away: { runs: 0 } },
    { home: { runs: 0 }, away: { runs: 0 } },
    { home: { runs: 0 }, away: { runs: 0 } },
    { home: { runs: 10 }, away: { runs: 10 } }, // inning 6 should be ignored
  ];
  assert.equal(sumF5Runs(innings, "home"), 1);
  assert.equal(sumF5Runs(innings, "away"), 0);
});

test("sumF5Runs: handles missing run values", () => {
  const innings = [
    { home: { runs: 1 }, away: {} },
    { home: {}, away: { runs: 2 } },
    { home: { runs: 0 }, away: { runs: 0 } },
    { home: { runs: 0 }, away: { runs: 0 } },
    { home: { runs: 0 }, away: { runs: 0 } },
  ];
  assert.equal(sumF5Runs(innings, "home"), 1);
  assert.equal(sumF5Runs(innings, "away"), 2);
});

test("sumF5Runs: returns 0 for null innings", () => {
  assert.equal(sumF5Runs(undefined, "home"), 0);
  assert.equal(sumF5Runs([], "home"), 0);
});

// ── isFifthInningComplete tests ──────────────────────────────────────

test("isFifthInningComplete: true when 5th inning isComplete", () => {
  const innings = [
    { isComplete: true },
    { isComplete: true },
    { isComplete: true },
    { isComplete: true },
    { isComplete: true }, // inning 5 (index 4)
  ];
  assert.equal(isFifthInningComplete(innings), true);
});

test("isFifthInningComplete: false when 5th inning not complete", () => {
  const innings = [
    { isComplete: true },
    { isComplete: true },
    { isComplete: true },
    { isComplete: true },
    { isComplete: false },
  ];
  assert.equal(isFifthInningComplete(innings), false);
});

test("isFifthInningComplete: false when fewer than 5 innings exist", () => {
  const innings = [
    { isComplete: true },
    { isComplete: true },
    { isComplete: true },
    { isComplete: true },
  ];
  assert.equal(isFifthInningComplete(innings), false);
});

test("isFifthInningComplete: false for undefined", () => {
  assert.equal(isFifthInningComplete(undefined), false);
});

// ── gradeF5Pick tests ────────────────────────────────────────────────

const DATE = "2026-06-12";

function seedF5Pick(gameId: string, market: "h2h_f5" | "totals_f5", pickSide: string, price: number, line?: number) {
  upsertF5Pick({
    gameId,
    gameDate: DATE,
    market,
    pickSide,
    price,
    line: line ?? null,
    tier: "EDGE",
  });
  return f5PickId(gameId, market, pickSide);
}

// Ensure DB is initialized before tests
gradedDb();

test("F5 SQLite migration: picks_f5 table exists", () => {
  const db = gradedDb();
  const tbl = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='picks_f5'")
    .get() as { name: string } | undefined;
  assert.equal(tbl?.name, "picks_f5");
});

test("upsertF5Pick stores a row", () => {
  seedF5Pick("game1", "h2h_f5", "home", -130);
  const picks = getF5PicksForDate(DATE);
  assert.ok(picks.some((p) => p.gameId === "game1"));
});

test("gradeF5Pick: H2H home win grades W", () => {
  const id = seedF5Pick("gameH2hW", "h2h_f5", "home", -130);
  const pick = gradedDb().prepare("SELECT * FROM picks_f5 WHERE id = ?").get(id) as import("../gradedBook").F5PickRow;
  const result = gradeF5Pick(pick, 4, 2); // home wins
  assert.equal(result, "W");
  const updated = gradedDb().prepare("SELECT * FROM picks_f5 WHERE id = ?").get(id) as import("../gradedBook").F5PickRow;
  assert.equal(updated.result, "W");
  assert.equal(updated.actual_home_runs_f5, 4);
  assert.equal(updated.actual_away_runs_f5, 2);
  assert.equal(updated.status, "final");
});

test("gradeF5Pick: H2H home loss grades L", () => {
  const id = seedF5Pick("gameH2hL", "h2h_f5", "home", -130);
  const pick = gradedDb().prepare("SELECT * FROM picks_f5 WHERE id = ?").get(id) as import("../gradedBook").F5PickRow;
  const result = gradeF5Pick(pick, 1, 3);
  assert.equal(result, "L");
});

test("gradeF5Pick: H2H tie grades P", () => {
  const id = seedF5Pick("gameH2hP", "h2h_f5", "home", -130);
  const pick = gradedDb().prepare("SELECT * FROM picks_f5 WHERE id = ?").get(id) as import("../gradedBook").F5PickRow;
  const result = gradeF5Pick(pick, 2, 2);
  assert.equal(result, "P");
});

test("gradeF5Pick: totals over win grades W", () => {
  const id = seedF5Pick("gameTotO", "totals_f5", "over", -110, 4.5);
  const pick = gradedDb().prepare("SELECT * FROM picks_f5 WHERE id = ?").get(id) as import("../gradedBook").F5PickRow;
  const result = gradeF5Pick(pick, 3, 2); // total = 5 > 4.5
  assert.equal(result, "W");
});

test("gradeF5Pick: totals under win grades W", () => {
  const id = seedF5Pick("gameTotU", "totals_f5", "under", -110, 4.5);
  const pick = gradedDb().prepare("SELECT * FROM picks_f5 WHERE id = ?").get(id) as import("../gradedBook").F5PickRow;
  const result = gradeF5Pick(pick, 1, 2); // total = 3 < 4.5
  assert.equal(result, "W");
});

test("gradeF5Pick: totals push grades P", () => {
  const id = seedF5Pick("gameTotP", "totals_f5", "over", -110, 4.5);
  const pick = gradedDb().prepare("SELECT * FROM picks_f5 WHERE id = ?").get(id) as import("../gradedBook").F5PickRow;
  // No exact push on half-line, try whole line
  const id2 = seedF5Pick("gameTotP2", "totals_f5", "over", -110, 5.0);
  const pick2 = gradedDb().prepare("SELECT * FROM picks_f5 WHERE id = ?").get(id2) as import("../gradedBook").F5PickRow;
  const result = gradeF5Pick(pick2, 3, 2); // total = 5 = line
  assert.equal(result, "P");
});

test("getF5PicksForDate returns only picks for that date", () => {
  const picks = getF5PicksForDate(DATE);
  for (const p of picks) {
    assert.equal(p.gameDate, DATE);
  }
});

test("f5PickId is deterministic", () => {
  const id1 = f5PickId("g1", "h2h_f5", "home");
  const id2 = f5PickId("g1", "h2h_f5", "home");
  assert.equal(id1, id2);
});

test("f5PickId format includes 'f5:' prefix", () => {
  const id = f5PickId("abc", "h2h_f5", "home");
  assert.ok(id.startsWith("f5:"), `expected f5: prefix, got: ${id}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
