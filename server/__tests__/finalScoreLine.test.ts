// Final picks must carry the scores the final-card treatment renders. Two
// surfaces: (1) the slate decoration attaches finalAwayScore/finalHomeScore so
// the live board can show "FINAL · Away 3 — Home 2"; (2) the archived row stores
// + composes the same score string after the pick leaves the board.
// Network-free — seeds a temp graded book directly.
// Run: tsx server/__tests__/finalScoreLine.test.ts

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graded-finalscore-"));
process.env.GRADED_BOOK_PATH = path.join(tmpDir, "test_book.db");
process.env.BANKROLL_USD = "25000";

const { forceInsertPick, settlePick, recordGradeLedger, pickId, archivedPicks } =
  await import("../gradedBook");
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
const GAME = "fs-final";

const input: UpsertPickInput = {
  gameId: GAME, sport: "mlb", gameDate: DAY, gameTimeEt: "7:05 PM",
  matchup: "NYY @ CLE", homeTeam: "CLE", awayTeam: "NYY",
  homeTeamFull: "Guardians", awayTeamFull: "Yankees",
  pickSide: "away", pickTeam: "NYY", pickTeamFull: "Yankees", pickType: "ML",
  pickLine: null, pickMl: -120, pickBook: "test",
  gameStartIso: `${DAY}T23:05:00Z`,
  tier: "EDGE", units: 1, stakeDollars: 100,
  pickWinProb: 0.55, pickImpliedProb: 0.5, edgePp: 5, evPer100: 4, confidence: 70, fairMl: -130,
};
const id = forceInsertPick(input);
settlePick(id, {
  finalAwayScore: 3, finalHomeScore: 2, result: "W", pl: 0.83,
  clvPct: 1.4, liveStatusDetail: "Final",
});

console.log("final score line");

test("decorateSlatePicks attaches final scores to a final board pick", () => {
  const p = { gameId: GAME, pickType: "ML", pickSide: "away", pickMl: -120 } as unknown as BuiltPick;
  decorateSlatePicks([p], DAY);
  assert.equal(p.gradeStatus, "final");
  assert.equal(p.gradeResult, "W");
  assert.equal(p.finalAwayScore, 3);
  assert.equal(p.finalHomeScore, 2);
});

test("archived row composes the FINAL score string from stored scores + short names", () => {
  recordGradeLedger(id);
  const item = archivedPicks().items.find((i) => i.pick_id === pickId(GAME, "ML", "away"))!;
  assert.ok(item, "pick lands in the archive");
  assert.equal(item.final_score, "NYY 3 — CLE 2");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
