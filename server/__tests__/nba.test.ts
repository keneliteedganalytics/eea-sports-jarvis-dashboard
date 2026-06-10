// NBA model + engine tests. Covers possession projection, home court, rest/b2b,
// injury point swings, market shrinkage, prob clamp, and a Finals fixture
// (Knicks vs Spurs, 2026-06-08). Run: tsx server/__tests__/nba.test.ts

import assert from "node:assert/strict";

import {
  predictGame,
  NBA_LG_ORTG,
  NBA_LG_PACE,
  NBA_HOME_PTS,
  NBA_B2B_PTS,
  PROB_CLAMP_LO,
  PROB_CLAMP_HI,
  type NbaModelContext,
  type TeamHoopStats,
} from "../sports/nba/model";
import { buildPick, type NbaGameInput } from "../sports/nba/picksEngine";

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

console.log("nba model + engine");

const stats = (o: Partial<TeamHoopStats>): TeamHoopStats => ({ available: true, ortg: NBA_LG_ORTG, drtg: NBA_LG_ORTG, pace: NBA_LG_PACE, ...o });

function ctx(over: Partial<NbaModelContext> = {}): NbaModelContext {
  return {
    homeTeam: "NYK", awayTeam: "SAS",
    homeTeamFull: "New York Knicks", awayTeamFull: "San Antonio Spurs",
    homeStats: stats({}), awayStats: stats({}),
    homeFairProb: null, awayFairProb: null,
    ...over,
  };
}

test("league-average teams → home favored by home-court (~52-54%)", () => {
  const r = predictGame(ctx());
  assert.ok(r.homeWinProb > 0.5, `home should be favored, got ${r.homeWinProb}`);
  assert.ok(r.projHomePoints > r.projAwayPoints, "home projects more points");
});

test("stronger ORtg + better opponent DRtg → higher home win prob", () => {
  const weak = predictGame(ctx());
  const strong = predictGame(ctx({ homeStats: stats({ ortg: 122, drtg: 108 }) }));
  assert.ok(strong.homeWinProb > weak.homeWinProb, "elite home team wins more");
});

test("home back-to-back docks points and lowers home win prob", () => {
  const rested = predictGame(ctx());
  const b2b = predictGame(ctx({ homeRestDays: 0, awayRestDays: 2 }));
  assert.ok(b2b.projHomePoints < rested.projHomePoints, "b2b home scores fewer");
  assert.ok(b2b.homeWinProb < rested.homeWinProb, "b2b lowers home win prob");
  assert.ok(b2b.modelNotes.some((n) => /back-to-back/.test(n)));
});

test("b2b deduction is approximately NBA_B2B_PTS", () => {
  const rested = predictGame(ctx({ homeRestDays: 2, awayRestDays: 2 }));
  const b2b = predictGame(ctx({ homeRestDays: 0, awayRestDays: 2 }));
  const drop = rested.projHomePoints - b2b.projHomePoints;
  // b2b dock + a 2-day rest-edge half-swing; should be at least NBA_B2B_PTS
  assert.ok(drop >= NBA_B2B_PTS - 0.5, `drop ${drop} should be >= ~${NBA_B2B_PTS}`);
});

test("rest-day edge favors the rested side", () => {
  const r = predictGame(ctx({ homeRestDays: 3, awayRestDays: 1 }));
  assert.ok(r.projHomePoints > r.projAwayPoints, "rested home up");
});

test("injury to home star docks home points and win prob", () => {
  const healthy = predictGame(ctx());
  const hurt = predictGame(ctx({ homeInjuryPts: 6 }));
  assert.ok(hurt.projHomePoints < healthy.projHomePoints - 5, "6-pt injury removed");
  assert.ok(hurt.homeWinProb < healthy.homeWinProb, "injury lowers home prob");
  assert.ok(hurt.modelNotes.some((n) => /home injuries/.test(n)));
});

test("away injury flips edge toward home", () => {
  const base = predictGame(ctx());
  const awayHurt = predictGame(ctx({ awayInjuryPts: 6 }));
  assert.ok(awayHurt.homeWinProb > base.homeWinProb, "away injury helps home");
});

test("market shrinkage pulls toward fair prob (MODEL_TRUST_WEIGHT)", () => {
  const r = predictGame(ctx({ homeStats: stats({ ortg: 125, drtg: 105 }), homeFairProb: 0.5, awayFairProb: 0.5 }));
  assert.equal(r.shrinkageApplied, true);
  // formula would be very high; shrinkage keeps it below the unshrunk number
  assert.ok(r.homeWinProb < r.homeWinProbFormula, "shrinkage pulls toward market");
});

test("probability clamp holds [PROB_CLAMP_LO, PROB_CLAMP_HI]", () => {
  const r = predictGame(ctx({ homeStats: stats({ ortg: 140, drtg: 95 }), awayStats: stats({ ortg: 95, drtg: 140 }) }));
  assert.ok(r.homeWinProb <= PROB_CLAMP_HI + 1e-9, `clamp hi: ${r.homeWinProb}`);
  assert.ok(r.awayWinProb >= PROB_CLAMP_LO - 1e-9, `clamp lo away: ${r.awayWinProb}`);
});

test("missing team stats → MEDIUM data tier + league fallback note", () => {
  const r = predictGame(ctx({ homeStats: { available: false }, awayStats: { available: false } }));
  assert.equal(r.dataQualityTier, "MEDIUM");
  assert.ok(r.modelNotes.some((n) => /league/.test(n)));
});

test("fair money lines are produced", () => {
  const r = predictGame(ctx());
  assert.ok(r.fairHomeMl !== null && r.fairAwayMl !== null);
});

test("Finals fixture: Knicks vs Spurs builds a valid pick with polymarket", () => {
  const game: NbaGameInput = {
    gameId: "nba-final-1",
    gameDate: "2026-06-08",
    gameTimeEt: "8:30 PM ET",
    venue: "Madison Square Garden",
    homeTeam: "NYK", awayTeam: "SAS",
    homeTeamFull: "New York Knicks", awayTeamFull: "San Antonio Spurs",
    mlHome: -130, mlAway: 110,
    mlHomeBook: "DraftKings", mlAwayBook: "FanDuel",
    homeFairProb: 0.56, awayFairProb: 0.44,
    spreadHomeLine: -2.5, spreadHomePrice: -110, spreadAwayLine: 2.5, spreadAwayPrice: -110, spreadBook: "DK",
    totalLine: 214.5, totalOverPrice: -110, totalUnderPrice: -110, totalBook: "DK",
    _homeStats: stats({ ortg: 118, drtg: 112 }),
    _awayStats: stats({ ortg: 115, drtg: 113 }),
    _polymarketData: { found: true, pct: 57.0 },
    _awayInjuryPts: 2.5,
    _awayInjuries: ["Some Guard"],
  };
  const model = predictGame({
    homeTeam: game.homeTeam, awayTeam: game.awayTeam,
    homeTeamFull: game.homeTeamFull, awayTeamFull: game.awayTeamFull,
    homeStats: game._homeStats!, awayStats: game._awayStats!,
    homeFairProb: game.homeFairProb, awayFairProb: game.awayFairProb,
    awayInjuryPts: game._awayInjuryPts,
  });
  const pick = buildPick(game, model, 25000);
  assert.ok(pick.pickTeamFull === "New York Knicks" || pick.pickTeamFull === "San Antonio Spurs");
  assert.equal(pick.polymarket.found, true);
  assert.ok(pick.confidence >= 0 && pick.confidence <= 100);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
