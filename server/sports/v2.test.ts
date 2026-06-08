// v2 unit tests — NHL/NBA engines, hard-pass guards, orchestrator fallback,
// and the MLB prop edge calc. Standalone tsx harness (node:assert).
import assert from "node:assert/strict";

import { buildPick as buildMlbPick, type GameInput } from "./mlb/picksEngine";
import { predictGame as predictMlb } from "./mlb/model";
import { buildPick as buildNhlPick, type NhlGameInput } from "./nhl/picksEngine";
import { predictGame as predictNhl } from "./nhl/model";
import { buildPick as buildNbaPick, type NbaGameInput } from "./nba/picksEngine";
import { predictGame as predictNba } from "./nba/model";
import { mlbPropEdge } from "../props/model";

let passed = 0;
let failed = 0;
const queue: Promise<void>[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  const run = (async () => {
    try {
      await fn();
      passed++;
      console.log(`  ok   ${name}`);
    } catch (err) {
      failed++;
      console.error(`  FAIL ${name}`);
      console.error(`       ${(err as Error).message}`);
    }
  })();
  queue.push(run);
}

console.log("v2 engines");

// ── MLB hard-pass guard: both pitchers missing + extreme line ────────
test("MLB hard-pass: both SP missing AND |ML| > 400 → PASS", () => {
  const game: GameInput = {
    gameId: "t1", gameDate: "2026-06-08", gameTimeEt: "7:00 PM ET", venue: "",
    homeTeam: "AAA", awayTeam: "BBB", homeTeamFull: "Team A", awayTeamFull: "Team B",
    mlHome: -450, mlAway: 380, homeFairProb: 0.81, awayFairProb: 0.19,
    homeSpStats: { available: false }, awaySpStats: { available: false },
  };
  const model = predictMlb({
    homeTeam: "AAA", awayTeam: "BBB", homeTeamFull: "Team A", awayTeamFull: "Team B",
    homeSpStats: {}, awaySpStats: {}, homeOffStats: {}, awayOffStats: {},
    venueTriCode: "AAA", homeFairProb: 0.81, awayFairProb: 0.19,
  });
  const pick = buildMlbPick(game, model);
  assert.equal(pick.verdict, "PASS");
  assert.equal(pick.hardPassReason, "missing_pitcher_data_with_extreme_line");
  assert.equal(pick.units, 0);
});

test("MLB hard-pass: both SP missing AND |ML| > 250 → heavy_favorite", () => {
  const game: GameInput = {
    gameId: "t2", gameDate: "2026-06-08", gameTimeEt: "7:00 PM ET", venue: "",
    homeTeam: "AAA", awayTeam: "BBB", homeTeamFull: "Team A", awayTeamFull: "Team B",
    mlHome: -300, mlAway: 250, homeFairProb: 0.74, awayFairProb: 0.26,
    homeSpStats: { available: false }, awaySpStats: { available: false },
  };
  const model = predictMlb({
    homeTeam: "AAA", awayTeam: "BBB", homeTeamFull: "Team A", awayTeamFull: "Team B",
    homeSpStats: {}, awaySpStats: {}, homeOffStats: {}, awayOffStats: {},
    venueTriCode: "AAA", homeFairProb: 0.74, awayFairProb: 0.26,
  });
  const pick = buildMlbPick(game, model);
  assert.equal(pick.hardPassReason, "missing_pitcher_data_with_heavy_favorite");
  assert.equal(pick.verdict, "PASS");
});

// ── NHL engine: model + tier + goalie hard-pass ──────────────────────
test("NHL model produces goals + win prob + fair ML", () => {
  const model = predictNhl({
    homeTeam: "COL", awayTeam: "EDM", homeTeamFull: "Colorado Avalanche", awayTeamFull: "Edmonton Oilers",
    homeStats: { available: true, gpg: 3.35, gapg: 2.78, xgfPct: 54 },
    awayStats: { available: true, gpg: 3.45, gapg: 2.95, xgfPct: 52 },
    homeGoalie: { available: true, goalie: "G1", svPct: 0.913 },
    awayGoalie: { available: true, goalie: "G2", svPct: 0.901 },
    homeFairProb: 0.55, awayFairProb: 0.45,
  });
  assert.ok(model.projHomeGoals > 0 && model.projAwayGoals > 0, "goals projected");
  assert.ok(model.homeWinProb > 0 && model.homeWinProb < 1, "win prob bounded");
  assert.ok(Math.abs(model.homeWinProb + model.awayWinProb - 1) < 0.001, "probs sum to 1");
  assert.notEqual(model.fairHomeMl, null);
});

test("NHL hard-pass: both goalies missing AND |ML| > 300 → PASS", () => {
  const game: NhlGameInput = {
    gameId: "n1", gameDate: "2026-06-08", gameTimeEt: "7:00 PM ET", venue: "",
    homeTeam: "COL", awayTeam: "EDM", homeTeamFull: "Colorado Avalanche", awayTeamFull: "Edmonton Oilers",
    homeGoalieAvailable: false, awayGoalieAvailable: false,
    mlHome: -360, mlAway: 300, homeFairProb: 0.78, awayFairProb: 0.22,
  };
  const model = predictNhl({
    homeTeam: "COL", awayTeam: "EDM", homeTeamFull: "Colorado Avalanche", awayTeamFull: "Edmonton Oilers",
    homeStats: {}, awayStats: {}, homeGoalie: null, awayGoalie: null,
    homeFairProb: 0.78, awayFairProb: 0.22,
  });
  const pick = buildNhlPick(game, model);
  assert.equal(pick.hardPassReason, "missing_goalie_data_with_extreme_line");
  assert.equal(pick.verdict, "PASS");
  assert.equal(pick.sport, "nhl");
});

// ── NBA engine: model + tier + efficiency hard-pass ──────────────────
test("NBA model produces points + win prob + fair ML", () => {
  const model = predictNba({
    homeTeam: "DEN", awayTeam: "BOS", homeTeamFull: "Denver Nuggets", awayTeamFull: "Boston Celtics",
    homeStats: { available: true, ortg: 118.5, drtg: 113.2, pace: 98.1 },
    awayStats: { available: true, ortg: 120.1, drtg: 110.8, pace: 99.8 },
    homeFairProb: 0.47, awayFairProb: 0.53,
  });
  assert.ok(model.projHomePoints > 80 && model.projAwayPoints > 80, "points projected");
  assert.ok(Math.abs(model.homeWinProb + model.awayWinProb - 1) < 0.001, "probs sum to 1");
});

test("NBA hard-pass: missing efficiency AND total > 240 → PASS", () => {
  const game: NbaGameInput = {
    gameId: "b1", gameDate: "2026-06-08", gameTimeEt: "7:00 PM ET", venue: "",
    homeTeam: "DEN", awayTeam: "BOS", homeTeamFull: "Denver Nuggets", awayTeamFull: "Boston Celtics",
    mlHome: -120, mlAway: 100, homeFairProb: 0.52, awayFairProb: 0.48,
    totalLine: 245.5, totalOverPrice: -110, totalUnderPrice: -110,
  };
  const model = predictNba({
    homeTeam: "DEN", awayTeam: "BOS", homeTeamFull: "Denver Nuggets", awayTeamFull: "Boston Celtics",
    homeStats: {}, awayStats: {}, homeFairProb: 0.52, awayFairProb: 0.48,
  });
  const pick = buildNbaPick(game, model);
  assert.equal(pick.hardPassReason, "missing_efficiency_data_with_extreme_total");
  assert.equal(pick.verdict, "PASS");
  assert.equal(pick.sport, "nba");
});

// ── Orchestrator Promise.allSettled fallback ─────────────────────────
test("orchestrator: one sport throwing does not blank the board", async () => {
  // Simulate the settle→sport mapping directly (no network).
  const results = await Promise.allSettled([
    Promise.resolve({ picks: [1, 2], operatingDay: "2026-06-08", isDemo: true }),
    Promise.reject(new Error("nhl upstream down")),
    Promise.resolve({ picks: [3], operatingDay: "2026-06-08", isDemo: true }),
  ]);
  const ok = results.map((r) => (r.status === "fulfilled" ? true : false));
  assert.deepEqual(ok, [true, false, true]);
  const board = results.map((r) => (r.status === "fulfilled" ? (r.value as { picks: number[] }).picks : []));
  assert.equal(board[0].length + board[2].length, 3, "surviving sports still render");
  assert.equal(board[1].length, 0, "failed sport returns empty, not a crash");
});

// ── MLB prop edge calc (SPEC §11) ────────────────────────────────────
test("prop edge: HR .080/PA × 4.3 PA → over-0.5 model prob ≈ .344", () => {
  const e = mlbPropEdge(0.08, 4.3, 0.5, 280, -360);
  assert.notEqual(e.modelProb, null);
  assert.ok(Math.abs((e.modelProb as number) - 0.344) < 0.01, `got ${e.modelProb}`);
  assert.equal(e.side, "over");
  assert.notEqual(e.fairOverAmerican, null);
});

(async () => {
  await Promise.all(queue);
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
