// Live-scoring against a real (temp) graded book: a persisted pending pick moves
// pending → in_progress → final, and the final transition grades it exactly once
// with the right result + P/L. Uses a throwaway DB via GRADED_BOOK_PATH.
// Run: tsx server/__tests__/liveScoring.test.ts

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point the graded book at a fresh temp file BEFORE importing the modules that
// open it.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graded-"));
process.env.GRADED_BOOK_PATH = path.join(tmpDir, "test_book.db");

const { upsertPick, openPicksForDate, getPick, pickId } = await import("../gradedBook");
const { applyEventsToPicks } = await import("../jobs/liveScoring");
const { parseEspnEvent } = await import("../adapters/espnLive");

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

console.log("live scoring + grading round-trip");

const DATE = "2026-06-08";

function seedPick() {
  upsertPick({
    gameId: "nbaGame1", sport: "nba", gameDate: DATE, gameTimeEt: "7:00 PM ET",
    matchup: "SAS @ NYK", homeTeam: "NYK", awayTeam: "SAS",
    homeTeamFull: "New York Knicks", awayTeamFull: "San Antonio Spurs",
    pickSide: "home", pickTeam: "NYK", pickTeamFull: "New York Knicks", pickType: "ML",
    pickLine: null, pickMl: -125, pickBook: "DK", tier: "EDGE", units: 1, stakeDollars: 375,
    pickWinProb: 0.6, pickImpliedProb: 0.55, edgePp: 5, evPer100: 4, confidence: 70, fairMl: -130,
  });
}

function espnGame(name: string, completed: boolean, away: string | undefined, home: string | undefined, detail: string) {
  return parseEspnEvent({
    id: "x", date: `${DATE}T23:00Z`,
    competitions: [
      {
        status: { type: { name, completed, shortDetail: detail } },
        competitors: [
          { homeAway: "home", score: home, team: { abbreviation: "NY", displayName: "New York Knicks" } },
          { homeAway: "away", score: away, team: { abbreviation: "SA", displayName: "San Antonio Spurs" } },
        ],
      },
    ],
  })!;
}

const id = pickId("nbaGame1", "ML", "home");

test("persisted pick starts pending", () => {
  seedPick();
  assert.equal(getPick(id)!.status, "pending");
});

test("in-progress event sets status in_progress + live score, no grade", () => {
  const summary = { date: DATE, scanned: 0, updated: 0, graded: 0 };
  applyEventsToPicks(openPicksForDate(DATE), [espnGame("STATUS_IN_PROGRESS", false, "60", "55", "Q3 4:20")], summary);
  const row = getPick(id)!;
  assert.equal(row.status, "in_progress");
  assert.equal(row.liveAwayScore, 60);
  assert.equal(row.liveHomeScore, 55);
  assert.equal(row.result, null);
  assert.equal(summary.graded, 0);
});

test("final event grades NYK home ML -125 as LOSS (SA 115 / NY 111)", () => {
  const summary = { date: DATE, scanned: 0, updated: 0, graded: 0 };
  applyEventsToPicks(openPicksForDate(DATE), [espnGame("STATUS_FINAL", true, "115", "111", "Final")], summary);
  const row = getPick(id)!;
  assert.equal(row.status, "final");
  assert.equal(row.result, "L");
  assert.equal(row.pl, -1);
  assert.equal(row.finalAwayScore, 115);
  assert.equal(row.finalHomeScore, 111);
  assert.equal(summary.graded, 1);
});

test("a graded pick is no longer 'open' — never graded twice", () => {
  const open = openPicksForDate(DATE);
  assert.equal(open.find((p) => p.id === id), undefined);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
