// Slate API decoration: every served pick must carry the grade + CLV fields
// (gradeStatus/result/pl, live + final scores, and the clv badge) that the
// orchestrator merges from the graded book. Regression for v6.3, where the
// per-sport slate routes (/api/mlb/slate etc.) bypassed the decoration that
// only the cross-sport /api/slate applied, so cards rendered without CLV.
//
// Network-free: seeds a temp graded book with one in_progress, one final, and
// one pending (posted-odds) row, then runs the same decorateSlatePicks the
// routes call and asserts the merged shape on each pick.
// Run: tsx server/__tests__/slateClvFields.test.ts

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graded-clv-"));
process.env.GRADED_BOOK_PATH = path.join(tmpDir, "test_book.db");

const { forceInsertPick, updateLive, settlePick, pickId, gradedDb } = await import("../gradedBook");
const { decorateSlatePicks } = await import("../slate/orchestrator");
import type { UpsertPickInput } from "../gradedBook";
import type { BuiltPick } from "../sports/mlb/picksEngine";

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

const DAY = "2026-06-09";

// Minimal graded-book row. forceInsertPick stamps postedOddsAmerican = pickMl.
function seedRow(gameId: string, pickMl: number): UpsertPickInput {
  const input: UpsertPickInput = {
    gameId,
    sport: "mlb",
    gameDate: DAY,
    gameTimeEt: "7:05 PM",
    matchup: `AWY @ HOM (${gameId})`,
    homeTeam: "HOM",
    awayTeam: "AWY",
    homeTeamFull: "Home Team",
    awayTeamFull: "Away Team",
    pickSide: "home",
    pickTeam: "HOM",
    pickTeamFull: "Home Team",
    pickType: "ML",
    pickLine: null,
    pickMl,
    pickBook: "test",
    gameStartIso: "2026-06-09T23:05:00Z",
    tier: "A",
    units: 1,
    stakeDollars: 100,
    pickWinProb: 0.55,
    pickImpliedProb: 0.5,
    edgePp: 5,
    evPer100: 4,
    confidence: 70,
    fairMl: -120,
  };
  forceInsertPick(input);
  return input;
}

// A board pick that matches a seeded row by (gameId, pickType, pickSide). We only
// need the identity + pickMl fields decorateSlatePicks reads, so cast a partial.
function boardPick(gameId: string, pickMl: number | null): BuiltPick {
  return {
    gameId,
    pickType: "ML",
    pickSide: "home",
    pickMl,
  } as unknown as BuiltPick;
}

// Seed three rows in distinct grade states.
const PENDING = "game-pending";
const IN_PROGRESS = "game-live";
const FINAL = "game-final";

seedRow(PENDING, -110); // pending, has posted odds → 'open' CLV badge

seedRow(IN_PROGRESS, +140);
updateLive(pickId(IN_PROGRESS, "ML", "home"), {
  status: "in_progress",
  liveAwayScore: 2,
  liveHomeScore: 3,
  liveStatusDetail: "Top 5th",
});

seedRow(FINAL, -120);
// Lock the close so buildClvBadge produces a 'final' badge with captured CLV.
gradedDb()
  .prepare(
    `UPDATE picks SET lockStatus='final', closingOddsAmerican=-135, closingSource='pinnacle',
      clvPoints=15, clvPercent=2.5 WHERE id=@id`,
  )
  .run({ id: pickId(FINAL, "ML", "home") });
settlePick(pickId(FINAL, "ML", "home"), {
  finalAwayScore: 4,
  finalHomeScore: 6,
  result: "W",
  pl: 1.0,
  clvPct: 2.5,
  liveStatusDetail: "Final",
});

console.log("slate API: CLV + grade field decoration");

test("in_progress pick carries grade status + live scores + CLV badge", () => {
  const p = boardPick(IN_PROGRESS, +140);
  decorateSlatePicks([p], DAY);
  assert.equal(p.gradeStatus, "in_progress", "gradeStatus is in_progress");
  assert.equal(p.liveAwayScore, 2, "liveAwayScore merged");
  assert.equal(p.liveHomeScore, 3, "liveHomeScore merged");
  assert.equal(p.liveStatusDetail, "Top 5th", "liveStatusDetail merged");
  assert.ok(p.clv, "clv badge present");
  assert.equal(p.clv!.status, "open", "live-but-unlocked pick still shows open CLV");
  assert.equal(p.clv!.postedOdds, 140, "postedOdds carried from posted price");
});

test("final pick carries result, P/L, final scores, and locked CLV", () => {
  const p = boardPick(FINAL, -120);
  decorateSlatePicks([p], DAY);
  assert.equal(p.gradeStatus, "final", "gradeStatus is final");
  assert.equal(p.gradeResult, "W", "gradeResult merged");
  assert.equal(p.gradePl, 1.0, "gradePl merged");
  assert.equal(p.finalAwayScore, 4, "finalAwayScore merged");
  assert.equal(p.finalHomeScore, 6, "finalHomeScore merged");
  assert.ok(p.clv, "clv badge present");
  assert.equal(p.clv!.status, "final", "CLV status final");
  assert.equal(p.clv!.points, 15, "clv points captured");
  assert.equal(p.clv!.percent, 2.5, "clv percent captured");
  assert.equal(p.clv!.closingOdds, -135, "closing odds captured");
  assert.equal(p.clv!.closingSource, "pinnacle", "closing source captured");
});

test("pending pick with posted odds gets the open CLV badge (Lock at first pitch)", () => {
  const p = boardPick(PENDING, -110);
  decorateSlatePicks([p], DAY);
  assert.equal(p.gradeStatus, "pending", "gradeStatus is pending");
  assert.ok(p.clv, "clv badge present (not null) when posted odds exist");
  assert.equal(p.clv!.status, "open", "CLV status open before lock");
  assert.equal(p.clv!.postedOdds, -110, "postedOdds is the posted price");
  assert.equal(p.clv!.closingOdds, null, "closing odds null until lock worker runs");
});

test("pick with no graded row but a posted price still gets the open CLV badge", () => {
  const p = boardPick("game-not-in-book", +160);
  decorateSlatePicks([p], DAY);
  assert.equal(p.gradeStatus, undefined, "no grade status — not in book");
  assert.ok(p.clv, "clv badge present from posted price");
  assert.equal(p.clv!.status, "open", "open CLV badge");
  assert.equal(p.clv!.postedOdds, 160, "postedOdds from pickMl");
});

test("pick with no graded row and no posted price gets null CLV", () => {
  const p = boardPick("game-no-odds", null);
  decorateSlatePicks([p], DAY);
  assert.equal(p.clv, null, "clv null when no posted price exists");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
