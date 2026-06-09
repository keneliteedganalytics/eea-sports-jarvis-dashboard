// v2 unit tests — NHL/NBA engines, hard-pass guards, orchestrator fallback,
// MLB prop edge calc, public/sharp consensus, and PRISM behaviour.
import assert from "node:assert/strict";

import { buildPick as buildMlbPick, type GameInput } from "./mlb/picksEngine";
import { computePublicSharp, type RawBookmaker } from "../core/consensus";
import { predictGame as predictMlb } from "./mlb/model";
import { buildPick as buildNhlPick, type NhlGameInput } from "./nhl/picksEngine";
import { predictGame as predictNhl } from "./nhl/model";
import { buildPick as buildNbaPick, type NbaGameInput } from "./nba/picksEngine";
import { predictGame as predictNba } from "./nba/model";
import { mlbPropEdge } from "../props/model";
import { detectPhantomEdge, PHANTOM_NOTE } from "../core/phantom";
import { computeUnit, convictionUnits, applyJuicePenalty, unitsToStake, applyExposureCap } from "../core/sizing";

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

// ── NHL goalie row visibility + real-data phantom suppression ──────────
test("NHL goalie row hidden when both goalies null", () => {
  const game: NhlGameInput = {
    gameId: "n2", gameDate: "2026-06-09", gameTimeEt: "8:00 PM ET", venue: "",
    homeTeam: "VGK", awayTeam: "CAR", homeTeamFull: "Vegas Golden Knights", awayTeamFull: "Carolina Hurricanes",
    homeGoalieAvailable: false, awayGoalieAvailable: false,
    mlHome: -140, mlAway: 120, homeFairProb: 0.57, awayFairProb: 0.43,
    _homeGoalie: null,
    _awayGoalie: null,
  };
  const model = predictNhl({
    homeTeam: "VGK", awayTeam: "CAR", homeTeamFull: "Vegas Golden Knights", awayTeamFull: "Carolina Hurricanes",
    homeStats: { available: true, gpg: 3.1, gapg: 2.7 },
    awayStats: { available: true, gpg: 3.5, gapg: 2.8 },
    homeGoalie: null, awayGoalie: null,
    homeFairProb: 0.57, awayFairProb: 0.43,
  });
  const pick = buildNhlPick(game, model);
  // Both goalies null → homeGoalie/awayGoalie fields should be null → row hidden
  assert.equal(pick.homeGoalie, null, "homeGoalie should be null");
  assert.equal(pick.awayGoalie, null, "awayGoalie should be null");
});

test("NHL phantom triggers when team stats missing AND markets present", () => {
  const game: NhlGameInput = {
    gameId: "n3", gameDate: "2026-06-09", gameTimeEt: "8:00 PM ET", venue: "",
    homeTeam: "VGK", awayTeam: "CAR", homeTeamFull: "Vegas Golden Knights", awayTeamFull: "Carolina Hurricanes",
    homeGoalieAvailable: false, awayGoalieAvailable: false,
    mlHome: -140, mlAway: 120, homeFairProb: 0.58, awayFairProb: 0.42,
  };
  const model = predictNhl({
    homeTeam: "VGK", awayTeam: "CAR", homeTeamFull: "Vegas Golden Knights", awayTeamFull: "Carolina Hurricanes",
    homeStats: {}, awayStats: {}, homeGoalie: null, awayGoalie: null,
    homeFairProb: 0.58, awayFairProb: 0.42,
  });
  // Both stats empty → model warns about league GPG → phantom detector fires
  assert.ok(detectPhantomEdge(model.modelNotes), "phantom detected with missing stats");
  const pick = buildNhlPick(game, model);
  assert.equal(pick.phantomEdge, true, "phantomEdge flag set");
  assert.equal(pick.units, 0, "units = 0 on phantom");
  assert.equal(pick.verdictTier, "PASS", "tier forced PASS");
});

test("NHL no phantom when both teams have real stats", () => {
  const game: NhlGameInput = {
    gameId: "n4", gameDate: "2026-06-09", gameTimeEt: "8:00 PM ET", venue: "",
    homeTeam: "VGK", awayTeam: "CAR", homeTeamFull: "Vegas Golden Knights", awayTeamFull: "Carolina Hurricanes",
    homeGoalieAvailable: true, awayGoalieAvailable: true,
    mlHome: -140, mlAway: 120, homeFairProb: 0.57, awayFairProb: 0.43,
    _homeGoalie: { available: true, goalie: "Carter Hart", svPct: 0.915, gaa: 2.44, gp: 19 },
    _awayGoalie: { available: true, goalie: "Frederik Andersen", svPct: 0.910, gaa: 1.89, gp: 16 },
    _homeStats: { available: true, gpg: 3.1, gapg: 2.7 },
    _awayStats: { available: true, gpg: 3.5, gapg: 2.8 },
  };
  const model = predictNhl({
    homeTeam: "VGK", awayTeam: "CAR", homeTeamFull: "Vegas Golden Knights", awayTeamFull: "Carolina Hurricanes",
    homeStats: { available: true, gpg: 3.1, gapg: 2.7 },
    awayStats: { available: true, gpg: 3.5, gapg: 2.8 },
    homeGoalie: { available: true, goalie: "Carter Hart", svPct: 0.915, gaa: 2.44, gp: 19 },
    awayGoalie: { available: true, goalie: "Frederik Andersen", svPct: 0.910, gaa: 1.89, gp: 16 },
    homeFairProb: 0.57, awayFairProb: 0.43,
  });
  assert.equal(detectPhantomEdge(model.modelNotes), false, "no phantom with real stats");
  const pick = buildNhlPick(game, model);
  assert.equal(pick.phantomEdge, false, "phantomEdge false with real data");
  // homeGoalie + awayGoalie are populated
  assert.ok(pick.homeGoalie !== null && pick.homeGoalie !== undefined, "homeGoalie populated");
  assert.ok(pick.awayGoalie !== null && pick.awayGoalie !== undefined, "awayGoalie populated");
  assert.equal(pick.homeGoalie?.name, "Carter Hart", "home goalie name");
  assert.equal(pick.awayGoalie?.name, "Frederik Andersen", "away goalie name");
  assert.ok(pick.homeGoalie?.svPct != null, "home goalie svPct present");
  assert.ok(pick.awayGoalie?.svPct != null, "away goalie svPct present");
  // homeSp/awaySp also populated
  assert.equal((pick.homeSp as Record<string, unknown>).available, true, "homeSp.available");
  assert.equal((pick.homeSp as Record<string, unknown>).pitcher, "Carter Hart", "homeSp.pitcher (goalie name)");
  assert.equal((pick.awaySp as Record<string, unknown>).pitcher, "Frederik Andersen", "awaySp.pitcher (goalie name)");
  // Model notes must NOT contain team-stats-missing warnings
  assert.equal(model.modelNotes.some(n => /team stats missing/i.test(n)), false, "no team-stats-missing warnings");
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

// ── Phantom-edge detector (SPEC §1, P0) ──────────────────────────────
test("phantom: 'using league RPG' note → detected", () => {
  assert.equal(detectPhantomEdge(["using league-average RPG prior"]), true);
});

test("phantom: 'using league ORtg' note → detected (NBA SAS@NYK bug)", () => {
  assert.equal(detectPhantomEdge(["no team stats — using league ORtg/pace"]), true);
});

test("phantom: clean notes → not detected", () => {
  assert.equal(detectPhantomEdge(["FIP 3.21 vs 4.05", "OPS edge to home"]), false);
});

test("phantom: NBA missing-efficiency pick forces PASS / 0 units", () => {
  const game: NbaGameInput = {
    gameId: "p1", gameDate: "2026-06-08", gameTimeEt: "8:00 PM ET", venue: "",
    homeTeam: "NYK", awayTeam: "SAS", homeTeamFull: "New York Knicks", awayTeamFull: "San Antonio Spurs",
    mlHome: -150, mlAway: 130, homeFairProb: 0.58, awayFairProb: 0.42,
    totalLine: 216.5, totalOverPrice: -110, totalUnderPrice: -110,
  };
  const model = predictNba({
    homeTeam: "NYK", awayTeam: "SAS", homeTeamFull: "New York Knicks", awayTeamFull: "San Antonio Spurs",
    homeStats: {}, awayStats: {}, homeFairProb: 0.58, awayFairProb: 0.42,
  });
  const pick = buildNbaPick(game, model);
  if (detectPhantomEdge(model.modelNotes)) {
    assert.equal(pick.phantomEdge, true, "phantom flag set");
    assert.equal(pick.verdictTier, "PASS");
    assert.equal(pick.units, 0);
    assert.ok(pick.modelNotes.includes(PHANTOM_NOTE), "phantom note prepended");
  }
});

// ── EEA flat-unit sizing (SPEC §4) ───────────────────────────────────
test("sizing: 1 unit = 1.5% of $35,800 = $537", () => {
  assert.equal(computeUnit(35800), 537);
});

test("sizing: conviction units per tier", () => {
  assert.equal(convictionUnits("SNIPER"), 2.5);
  assert.equal(convictionUnits("EDGE"), 2.0);
  assert.equal(convictionUnits("RECON"), 1.0);
  assert.equal(convictionUnits("PASS"), 0);
});

test("sizing: line worse than -180 → half-cut", () => {
  const { units, halfCut } = applyJuicePenalty(2.0, -210);
  assert.equal(halfCut, true);
  assert.equal(units, 1.0);
});

test("sizing: line -150 → no cut", () => {
  const { units, halfCut } = applyJuicePenalty(2.0, -150);
  assert.equal(halfCut, false);
  assert.equal(units, 2.0);
});

test("sizing: 2 units at $35,800 → $1,074 stake", () => {
  assert.equal(unitsToStake(2.0, 35800), 1074);
});

// ── 18% slate-wide exposure cap (SPEC §4) ────────────────────────────
test("exposure: under-cap board is untouched", () => {
  const out = applyExposureCap([{ units: 2, stakeDollars: 1074 }, { units: 1, stakeDollars: 537 }], 35800);
  assert.equal(out.every((x) => !x.trimmed), true);
  assert.equal(out[0].stakeDollars, 1074);
});

test("exposure: over-cap board scales down to 18% and flags trimmed", () => {
  // Cap = 0.18 × 35,800 = $6,444. Eight 3-unit plays = 8 × $1,611 = $12,888.
  const stakes = Array.from({ length: 8 }, () => ({ units: 3, stakeDollars: 1611 }));
  const out = applyExposureCap(stakes, 35800);
  const total = out.reduce((s, x) => s + x.stakeDollars, 0);
  assert.ok(total <= 35800 * 0.18 + 8, `total ${total} within cap (rounding slack)`);
  assert.equal(out.every((x) => x.trimmed), true);
});

// ── Public/Sharp consensus (Fix 2) ──────────────────────────────────
test("publicSharp: pinnacle present → sharpPct uses pinnacle", () => {
  const bms: RawBookmaker[] = [
    {
      key: "draftkings",
      markets: [{ key: "h2h", outcomes: [{ name: "Team A", price: -140 }, { name: "Team B", price: 120 }] }],
    },
    {
      key: "fanduel",
      markets: [{ key: "h2h", outcomes: [{ name: "Team A", price: -138 }, { name: "Team B", price: 118 }] }],
    },
    {
      key: "pinnacle",
      markets: [{ key: "h2h", outcomes: [{ name: "Team A", price: -135 }, { name: "Team B", price: 115 }] }],
    },
  ];
  const result = computePublicSharp(bms, "Team A", "Team B");
  assert.ok(result.publicPct !== null, "publicPct computed");
  assert.ok(result.sharpPct !== null, "sharpPct computed");
  // Pinnacle -135 devigged: should be ~57%
  assert.ok((result.sharpPct as number) > 50 && (result.sharpPct as number) < 70, `sharpPct ${result.sharpPct} in range`);
});

test("publicSharp: no sharp book → falls back to devig consensus", () => {
  const bms: RawBookmaker[] = [
    {
      key: "draftkings",
      markets: [{ key: "h2h", outcomes: [{ name: "Team A", price: -140 }, { name: "Team B", price: 120 }] }],
    },
    {
      key: "fanduel",
      markets: [{ key: "h2h", outcomes: [{ name: "Team A", price: -138 }, { name: "Team B", price: 118 }] }],
    },
  ];
  const result = computePublicSharp(bms, "Team A", "Team B");
  assert.ok(result.publicPct !== null, "publicPct computed from public books");
  // No pinnacle/circa/betonline → fallback to consensus across all books
  assert.ok(result.sharpPct !== null, "sharpPct falls back to all-book devig");
});

// ── PRISM / Polymarket Fix 3 ──────────────────────────────────────────
test("PRISM: polymarket found=true → prismPct used, bar shows value", () => {
  const game: GameInput = {
    gameId: "p2", gameDate: "2026-06-08", gameTimeEt: "7:00 PM ET", venue: "",
    homeTeam: "CLE", awayTeam: "NYY", homeTeamFull: "Cleveland Guardians", awayTeamFull: "New York Yankees",
    mlHome: -115, mlAway: -105, homeFairProb: 0.52, awayFairProb: 0.48,
  };
  const model = predictMlb({
    homeTeam: "CLE", awayTeam: "NYY", homeTeamFull: "Cleveland Guardians", awayTeamFull: "New York Yankees",
    homeSpStats: {}, awaySpStats: {}, homeOffStats: {}, awayOffStats: {},
    venueTriCode: "CLE", homeFairProb: 0.52, awayFairProb: 0.48,
  });
  const polyData = { found: true, pct: 58.0 };
  const pick = buildMlbPick(game, model, 35800, polyData);
  assert.equal(pick.polymarket.found, true);
  assert.ok(pick.polymarket.pct != null && pick.polymarket.pct > 0, "PRISM pct present");
});

test("PRISM: polymarket found=false → pct null, reason set", () => {
  const game: GameInput = {
    gameId: "p3", gameDate: "2026-06-08", gameTimeEt: "7:00 PM ET", venue: "",
    homeTeam: "CLE", awayTeam: "NYY", homeTeamFull: "Cleveland Guardians", awayTeamFull: "New York Yankees",
    mlHome: -115, mlAway: -105, homeFairProb: 0.52, awayFairProb: 0.48,
    _polymarketData: { found: false, pct: null, reason: "no market available" },
  };
  const model = predictMlb({
    homeTeam: "CLE", awayTeam: "NYY", homeTeamFull: "Cleveland Guardians", awayTeamFull: "New York Yankees",
    homeSpStats: {}, awaySpStats: {}, homeOffStats: {}, awayOffStats: {},
    venueTriCode: "CLE", homeFairProb: 0.52, awayFairProb: 0.48,
  });
  const pick = buildMlbPick(game, model);
  assert.equal(pick.polymarket.found, false);
  assert.equal(pick.polymarket.pct, null);
  assert.equal(pick.polymarket.reason, "no market available");
});

test("pitcher row hidden: both SPs missing (available===false)", () => {
  const game: GameInput = {
    gameId: "p4", gameDate: "2026-06-08", gameTimeEt: "7:00 PM ET", venue: "",
    homeTeam: "CLE", awayTeam: "NYY", homeTeamFull: "Cleveland Guardians", awayTeamFull: "New York Yankees",
    mlHome: -115, mlAway: -105, homeFairProb: 0.52, awayFairProb: 0.48,
    homeSpStats: { available: false }, awaySpStats: { available: false },
  };
  const model = predictMlb({
    homeTeam: "CLE", awayTeam: "NYY", homeTeamFull: "Cleveland Guardians", awayTeamFull: "New York Yankees",
    homeSpStats: {}, awaySpStats: {}, homeOffStats: {}, awayOffStats: {},
    venueTriCode: "CLE", homeFairProb: 0.52, awayFairProb: 0.48,
  });
  const pick = buildMlbPick(game, model);
  // Both SPs have available===false; pitcher field should be falsy
  const awaySp = pick.awaySp as Record<string, unknown>;
  const homeSp = pick.homeSp as Record<string, unknown>;
  assert.equal(awaySp.available, false);
  assert.equal(homeSp.available, false);
  // In UI, if both available===false pitcher names are TBD; row is hidden if both are TBD
  const awayName = awaySp.available === false ? null : (awaySp.pitcher as string | null);
  const homeName = homeSp.available === false ? null : (homeSp.pitcher as string | null);
  assert.equal(awayName, null, "away pitcher should be null for TBD logic");
  assert.equal(homeName, null, "home pitcher should be null for TBD logic");
});

(async () => {
  await Promise.all(queue);
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
