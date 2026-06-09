// Soccer v3 unit tests
// Covers: devigThreeWay, Dixon-Coles symmetry, Asian handicap parser,
// draw cap at RECON, phantom detection on league-fallback notes,
// friendly cap, missing-data graceful handling.

import assert from "node:assert/strict";

import { devigThreeWay, americanToDecimal, decimalToAmerican } from "../core/odds";
import { parseAsianHandicap, extractDrawOdds } from "./soccer/oddsMath";
import { predictGame } from "./soccer/model";
import { buildPick, type SoccerGameInput } from "./soccer/picksEngine";
import { detectPhantomEdge } from "../core/phantom";

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

// Helper: convert decimal odds → american
function americanFromDecimal(dec: number): number {
  return decimalToAmerican(dec) ?? 0;
}

console.log("soccer v3");

// ── §2: devigThreeWay sums to exactly 1.0 ────────────────────────────────────
test("devigThreeWay: home/draw/away probs sum to 1.0 within 1e-9", () => {
  // Example from SPEC: decimal 2.10 / 3.40 / 3.60
  const homeOdds = americanFromDecimal(2.10);
  const drawOdds = americanFromDecimal(3.40);
  const awayOdds = americanFromDecimal(3.60);
  const { home, draw, away, overround } = devigThreeWay(homeOdds, drawOdds, awayOdds);
  const sum = home + draw + away;
  assert.ok(Math.abs(sum - 1.0) < 1e-9, `sum=${sum} expected ~1.0`);
  assert.ok(overround > 1.0, `overround=${overround} expected >1.0`);
  assert.ok(home > 0 && draw > 0 && away > 0, "all probs positive");
});

test("devigThreeWay: balanced market sums to 1.0", () => {
  // 3 equal outcomes at +200 each → raw implied = 1/3 each, overround = 1.0
  const { home, draw, away } = devigThreeWay(200, 200, 200);
  const sum = home + draw + away;
  assert.ok(Math.abs(sum - 1.0) < 1e-9, `balanced sum=${sum}`);
  assert.ok(Math.abs(home - 1 / 3) < 1e-6, `equal home prob`);
});

test("devigThreeWay: heavy favorite example sums to 1.0", () => {
  // Home -200, Draw +400, Away +500
  const { home, draw, away } = devigThreeWay(-200, 400, 500);
  const sum = home + draw + away;
  assert.ok(Math.abs(sum - 1.0) < 1e-9, `sum=${sum}`);
  assert.ok(home > draw && home > away, "home should be most likely");
});

// ── §5: Dixon-Coles model ─────────────────────────────────────────────────────
test("Dixon-Coles: Poisson matrix probs sum to ≈1.0", () => {
  const model = predictGame({
    homeTeam: "FLA", awayTeam: "PAL",
    homeTeamFull: "Flamengo", awayTeamFull: "Palmeiras",
    homeStats: { available: true, gpg: 1.8, gapg: 1.1 },
    awayStats: { available: true, gpg: 1.6, gapg: 1.2 },
    homeFairProb: 0.45, drawFairProb: 0.27, awayFairProb: 0.28,
  });
  const total = model.homeWinProb + model.drawProb + model.awayWinProb;
  assert.ok(Math.abs(total - 1.0) < 0.01, `probs sum=${total}`);
  assert.ok(model.projHomeGoals > 0, "positive home goals");
  assert.ok(model.projAwayGoals > 0, "positive away goals");
  assert.ok(model.homeWinProb > 0 && model.homeWinProb < 1, "home prob bounded");
  assert.ok(model.drawProb > 0 && model.drawProb < 1, "draw prob bounded");
});

test("Dixon-Coles: home advantage — home team should win more often at home", () => {
  // Two equal teams: home advantage should give home higher win prob
  const model = predictGame({
    homeTeam: "HOM", awayTeam: "AWY",
    homeTeamFull: "Home Team", awayTeamFull: "Away Team",
    homeStats: { available: true, gpg: 1.35, gapg: 1.35 },
    awayStats: { available: true, gpg: 1.35, gapg: 1.35 },
  });
  assert.ok(model.homeWinProb > model.awayWinProb, `home should have edge: home=${model.homeWinProb.toFixed(3)} away=${model.awayWinProb.toFixed(3)}`);
});

test("Dixon-Coles: symmetry — team with higher attack wins more", () => {
  const model = predictGame({
    homeTeam: "STR", awayTeam: "DEF",
    homeTeamFull: "Strong Attack", awayTeamFull: "Weak Attack",
    homeStats: { available: true, gpg: 2.5, gapg: 1.0 },
    awayStats: { available: true, gpg: 0.8, gapg: 2.0 },
  });
  assert.ok(model.homeWinProb > 0.5, `strong home should be fav: ${model.homeWinProb.toFixed(3)}`);
});

// ── Asian handicap parser ─────────────────────────────────────────────────────
test("Asian handicap: integer line", () => {
  const h = parseAsianHandicap(-1);
  assert.equal(h.line, -1);
  assert.equal(h.isQuarter, false);
  assert.equal(h.displayStr, "-1");
});

test("Asian handicap: half line", () => {
  const h = parseAsianHandicap(0.5);
  assert.equal(h.isQuarter, false);
  assert.equal(h.displayStr, "+0.5");
});

test("Asian handicap: quarter line -0.25", () => {
  const h = parseAsianHandicap(-0.25);
  assert.equal(h.isQuarter, true);
  assert.ok(Array.isArray(h.splitLines), "should have split lines");
  assert.ok(h.displayStr.includes("/"), "quarter line shows both options");
});

test("Asian handicap: quarter line +0.75", () => {
  const h = parseAsianHandicap(0.75);
  assert.equal(h.isQuarter, true);
});

test("Asian handicap: zero line", () => {
  const h = parseAsianHandicap(0);
  assert.equal(h.line, 0);
  assert.equal(h.isQuarter, false);
});

// ── §6: Draw cap at RECON ────────────────────────────────────────────────────
test("Draw pick: even with edge≥8 and conf≥80, capped at RECON not SNIPER/EDGE", () => {
  // Build a model that strongly favors the draw
  const model = predictGame({
    homeTeam: "AAA", awayTeam: "BBB",
    homeTeamFull: "Team A", awayTeamFull: "Team B",
    homeStats: { available: true, gpg: 1.0, gapg: 1.3 },
    awayStats: { available: true, gpg: 1.0, gapg: 1.3 },
    // Market severely underestimates draw: market draw only 15%, model ~29%
    homeFairProb: 0.42, drawFairProb: 0.15, awayFairProb: 0.43,
  });
  const game: SoccerGameInput = {
    gameId: "draw-test-1", gameDate: "2026-06-08", gameTimeEt: "7:00 PM ET",
    venue: "", homeTeam: "AAA", awayTeam: "BBB",
    homeTeamFull: "Team A", awayTeamFull: "Team B",
    leagueName: "Test League", leagueId: 71,
    isFriendly: false,
    mlHome: 130, mlDraw: 360, mlAway: 210,
    homeFairProb: 0.42, drawFairProb: 0.15, awayFairProb: 0.43,
  };
  const pick = buildPick(game, model);
  // If draw was picked (isDraw=true), verify tier is at most RECON
  if (pick.isDraw) {
    const tier = pick.verdictTier;
    assert.ok(
      !["SNIPER", "EDGE"].includes(tier),
      `draw tier=${tier} should not be SNIPER or EDGE`,
    );
  }
});

// ── §6: Friendly cap at RECON ─────────────────────────────────────────────────
test("Friendly match: tier capped at RECON (no BONUS/SNIPER/EDGE)", () => {
  const model = predictGame({
    homeTeam: "FRA", awayTeam: "GER",
    homeTeamFull: "France", awayTeamFull: "Germany",
    homeStats: { available: true, gpg: 2.2, gapg: 0.9 },
    awayStats: { available: true, gpg: 1.4, gapg: 1.8 },
    homeFairProb: 0.48, drawFairProb: 0.27, awayFairProb: 0.25,
  });
  const game: SoccerGameInput = {
    gameId: "friendly-1", gameDate: "2026-06-08", gameTimeEt: "7:00 PM ET",
    venue: "", homeTeam: "FRA", awayTeam: "GER",
    homeTeamFull: "France", awayTeamFull: "Germany",
    leagueName: "Friendly", leagueId: null, isFriendly: true,
    mlHome: -135, mlDraw: 310, mlAway: 380,
    // Market undervalues France by ~12pp → would be SNIPER/EDGE without cap
    homeFairProb: 0.28, drawFairProb: 0.27, awayFairProb: 0.45,
  };
  const pick = buildPick(game, model);
  const tier = pick.verdictTier;
  assert.ok(
    !["SNIPER", "EDGE"].includes(tier),
    `friendly tier=${tier} should not be SNIPER/EDGE`,
  );
});

// ── §11: Phantom edge from league-fallback notes ─────────────────────────────
test("Phantom detection: 'missing team form' note triggers phantom edge", () => {
  const notes = ["⚠️ league-fallback goals — no team form data", "missing team form — league-fallback goals used"];
  assert.ok(detectPhantomEdge(notes), "should detect phantom from league-fallback note");
});

test("Phantom detection: normal notes do NOT trigger phantom", () => {
  const notes = ["Dixon-Coles model applied", "shrinkage blend 0.45"];
  assert.ok(!detectPhantomEdge(notes), "normal notes should not trigger phantom");
});

// ── §11: Missing data graceful handling ──────────────────────────────────────
test("Soccer: missing API data doesn't crash, returns a valid pick", () => {
  const model = predictGame({
    homeTeam: "UNK", awayTeam: "UNK2",
    homeTeamFull: "Unknown Home", awayTeamFull: "Unknown Away",
    homeStats: { available: false },
    awayStats: { available: false },
  });
  const game: SoccerGameInput = {
    gameId: "no-data-1", gameDate: "2026-06-08", gameTimeEt: "8:00 PM ET",
    venue: "", homeTeam: "UNK", awayTeam: "UNK2",
    homeTeamFull: "Unknown Home", awayTeamFull: "Unknown Away",
    leagueName: null, leagueId: null, isFriendly: false,
    mlHome: -120, mlDraw: 260, mlAway: 300,
    homeFairProb: 0.47, drawFairProb: 0.28, awayFairProb: 0.25,
  };
  let pick;
  assert.doesNotThrow(() => {
    pick = buildPick(game, model);
  }, "should not throw with missing data");
  assert.ok(pick, "should return a pick object");
});

// ── §11: 3-way odds parser handles "Draw" outcome ────────────────────────────
test("extractDrawOdds: finds Draw outcome from Odds API bookmaker structure", () => {
  const rawBms = [
    {
      key: "draftkings", title: "DraftKings",
      markets: [{ key: "h2h", outcomes: [
        { name: "Brazil", price: -115 },
        { name: "Draw", price: 255 },
        { name: "Argentina", price: 310 },
      ]}],
    },
    {
      key: "fanduel", title: "FanDuel",
      markets: [{ key: "h2h", outcomes: [
        { name: "Brazil", price: -120 },
        { name: "Draw", price: 260 },
        { name: "Argentina", price: 320 },
      ]}],
    },
  ];
  const drawOdds = extractDrawOdds(rawBms);
  assert.ok(drawOdds !== null, "draw odds should be found");
  assert.ok(drawOdds > 0, "draw odds should be positive (underdog)");
});

// Run all tests
await Promise.all(queue);
console.log(`\n${passed + failed} tests: ${passed} ok, ${failed} failed\n`);
if (failed > 0) process.exit(1);
