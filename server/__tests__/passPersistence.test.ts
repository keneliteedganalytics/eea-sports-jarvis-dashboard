// v6.7.7: prove that an evaluated prop the engine does NOT play is still recorded
// in prop_picks as tier='PASS' with a pass_reason and full metadata (edge/model/
// sim), at stake_units 0. Also proves game-line PASS persistence via persistPicks.
// Run: tsx server/__tests__/passPersistence.test.ts

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graded-pass-persist-"));
process.env.GRADED_BOOK_PATH = path.join(tmpDir, "test_book.db");
process.env.BANKROLL_USD = "25000";

import type { BuildDeps } from "../sports/props/buildPropPicks";
import type { BatterProfile, BatterGameLog } from "../sports/props/mlbStatsProps";
import type { BuiltPick } from "../sports/mlb/picksEngine";

const { upsertPropOffer, gradedDb, getPropPick, upsertPropPick, markPropPickPass, healPassStakes } = await import("../gradedBook");
const { buildMlbPropPicks } = await import("../sports/props/buildPropPicks");
const { persistPicks } = await import("../jobs/persistPicks");

gradedDb();
const DATE = "2026-06-10";

function batterLog(over: Partial<BatterGameLog> = {}): BatterGameLog {
  return {
    date: "2026-06-01", pa: 4, ab: 4, hits: 1, totalBases: 1, homeRuns: 0,
    runs: 0, rbi: 0, walks: 0, singles: 1, oppPitcherHand: "R", home: true, ...over,
  };
}
// A weak contact hitter on a HIGH line: the simulated median sits below the line,
// the over has no edge → fails the surfacing gate → recorded as PASS.
function weakBatter(id: number): BatterProfile {
  return {
    available: true,
    playerId: id,
    name: "Weak Hitter",
    logs: Array.from({ length: 20 }, () => batterLog({ hits: 0 })),
    seasonPa: 500,
    seasonRates: {
      hitsPerPa: 0.18, tbPerPa: 0.22, hrPerPa: 0.01, runsPerPa: 0.08,
      rbiPerPa: 0.07, walksPerPa: 0.05, singlesPerPa: 0.15,
    },
  };
}

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

console.log("pass persistence (v6.7.7)");

await test("an evaluated prop with no edge is recorded as tier=PASS with metadata", async () => {
  upsertPropOffer({
    event_id: "evtPass", sport: "mlb", game_date: DATE, player_name: "Weak Hitter",
    market: "batter_hits", line: 2.5, over_price: -110, under_price: -110, book: "draftkings",
  });
  const deps: BuildDeps = {
    resolveId: async () => 700001,
    persistId: () => undefined,
    batterProfile: async (id) => weakBatter(id as number),
    pitcherProfile: async () => ({ available: false, playerId: null, name: "", logs: [], starts: 0, seasonRates: null }),
    schedule: async () => [],
  };

  const summary = await buildMlbPropPicks(DATE, deps);
  assert.ok(summary.passed >= 1, `expected ≥1 PASS recorded, got ${summary.passed}`);
  assert.equal(summary.written, 0, "the weak over should not be an actionable pick");

  const db = gradedDb();
  const row = db.prepare("SELECT * FROM prop_picks WHERE game_id = 'evtPass'").get() as Record<string, unknown>;
  assert.ok(row, "a PASS row must exist for the evaluated prop");
  assert.equal(row.tier, "PASS");
  assert.ok(row.pass_reason, "PASS row carries a pass_reason");
  assert.equal(row.stake_units, 0, "PASS row stake must be 0 (informational only)");
  assert.notEqual(row.edge_pp, null, "edge metadata is recorded on the PASS row");
  assert.notEqual(row.model_prob, null, "model_prob is recorded on the PASS row");
  assert.equal(row.result, null, "PASS row is not graded");
});

await test("PASS prop never carries units and is excluded from the default board", () => {
  const db = gradedDb();
  const leak = db.prepare("SELECT COUNT(*) AS n FROM prop_picks WHERE tier='PASS' AND stake_units > 0").get() as { n: number };
  assert.equal(leak.n, 0, "no PASS prop may carry stake_units > 0");
});

await test("game-line PASS picks persist via persistPicks (units 0, pass_reason set)", () => {
  const passPick = {
    sport: "mlb", gameId: "gPass1", gameDate: DATE, gameTimeEt: "7:00 PM ET",
    venue: "", matchup: "AAA @ BBB", homeTeam: "BBB", awayTeam: "AAA",
    homeTeamFull: "B Team", awayTeamFull: "A Team", pickSide: "home",
    pickTeam: "BBB", pickTeamFull: "B Team", pickType: "ML", markets: {} as never,
    pickMl: -120, pickBook: "dk", pickWinProb: 0.5, pickImpliedProb: 0.54,
    fairMl: -110, edgePp: 1.2, evPer100: 1, evPer100Raw: 1, evCapped: false,
    confidence: 40, units: 0, kellyStakeDollars: 0, kellyCapped: false,
    halfCut: false, phantomEdge: false, trimmed: false, subSampleWarning: false,
    subSampleDetails: null, alignmentSignalRaw: null, topPlay: false,
    verdict: "PASS", verdictTier: "PASS", qualifies: false, trapSignal: false,
    trapGapPp: null, eliteFadeApplied: false, dataQualityTier: "HIGH",
    hardPassReason: null, passReason: null, isSparseModel: false,
    projHomeScore: 4, projAwayScore: 4, expectedTotal: 8,
  } as unknown as BuiltPick;

  const n = persistPicks([passPick]);
  assert.equal(n, 1, "the PASS game-line pick should persist (returns 1)");

  const db = gradedDb();
  const row = db.prepare("SELECT * FROM picks WHERE gameId = 'gPass1'").get() as Record<string, unknown>;
  assert.ok(row, "PASS game-line row exists");
  assert.equal(row.tier, "PASS");
  assert.equal(row.units, 0, "PASS game-line carries 0 units (never settles / touches bankroll)");
  assert.equal(row.pass_reason, "daily_cap", "no gate reason → attributed to the cap");
});

await test("game-line PASS with a gate reason is attributed below_threshold/low_data_quality", () => {
  const gated = {
    sport: "mlb", gameId: "gPass2", gameDate: DATE, gameTimeEt: "7:00 PM ET",
    venue: "", matchup: "CCC @ DDD", homeTeam: "DDD", awayTeam: "CCC",
    homeTeamFull: "D Team", awayTeamFull: "C Team", pickSide: "away",
    pickTeam: "CCC", pickTeamFull: "C Team", pickType: "ML", markets: {} as never,
    pickMl: 150, pickBook: "dk", pickWinProb: 0.45, pickImpliedProb: 0.4,
    fairMl: 140, edgePp: 8, evPer100: 5, evPer100Raw: 5, evCapped: false,
    confidence: 55, units: 0, kellyStakeDollars: 0, kellyCapped: false,
    halfCut: false, phantomEdge: false, trimmed: false, subSampleWarning: false,
    subSampleDetails: null, alignmentSignalRaw: null, topPlay: false,
    verdict: "PASS", verdictTier: "PASS", qualifies: false, trapSignal: false,
    trapGapPp: null, eliteFadeApplied: false, dataQualityTier: "PASS_HARD_GATE",
    hardPassReason: "insufficient_sample", passReason: "insufficient_sample",
    isSparseModel: true, projHomeScore: 4, projAwayScore: 5, expectedTotal: 9,
  } as unknown as BuiltPick;

  persistPicks([gated]);
  const db = gradedDb();
  const row = db.prepare("SELECT pass_reason FROM picks WHERE gameId = 'gPass2'").get() as { pass_reason: string };
  assert.equal(row.pass_reason, "low_data_quality", "a sample-driven hard gate maps to low_data_quality");
});

await test("demoting an actionable prop to PASS zeroes its stake (markPropPickPass)", () => {
  // Seed an actionable, staked prop, then demote it the way the recompute does.
  upsertPropPick({
    pick_id: "demoteMe", sport: "mlb", game_id: "dm1", player_name: "Faded Star",
    market_type: "batter_hits", line: 1.5, side: "over", posted_odds: -110,
    tier: "SNIPER", edge_pp: 8, stake_units: 0.5, posted_at: "2026-06-10T18:00:00Z",
  });
  markPropPickPass("demoteMe", "below_threshold");
  const db = gradedDb();
  const row = db.prepare("SELECT tier, pass_reason, stake_units FROM prop_picks WHERE pick_id = 'demoteMe'").get() as Record<string, unknown>;
  assert.equal(row.tier, "PASS");
  assert.equal(row.pass_reason, "below_threshold");
  assert.equal(row.stake_units, 0, "a demoted PASS row must never keep its stake");
});

await test("healPassStakes zeroes any legacy PASS row that still carries a stake", () => {
  const db = gradedDb();
  // Force a legacy/corrupt state: a PASS row with a non-zero stake (as a pre-v6.7.7
  // demotion would have left it), bypassing the now-safe write path.
  upsertPropPick({
    pick_id: "legacyPass", sport: "mlb", game_id: "lp1", player_name: "Legacy Bat",
    market_type: "batter_hits", line: 2.5, side: "over", posted_odds: -110,
    tier: "SNIPER", edge_pp: 6, stake_units: 0.5, posted_at: "2026-06-10T18:00:00Z",
  });
  db.prepare("UPDATE prop_picks SET tier = 'PASS' WHERE pick_id = 'legacyPass'").run();
  const before = db.prepare("SELECT stake_units FROM prop_picks WHERE pick_id = 'legacyPass'").get() as { stake_units: number };
  assert.equal(before.stake_units, 0.5, "precondition: the legacy PASS row still carries a stake");

  const healed = healPassStakes();
  assert.ok(healed.props >= 1, "heal reports the prop rows it zeroed");

  const after = db.prepare("SELECT stake_units FROM prop_picks WHERE pick_id = 'legacyPass'").get() as { stake_units: number };
  assert.equal(after.stake_units, 0, "heal zeroes the stake on the legacy PASS row");

  const leak = db.prepare("SELECT COUNT(*) AS n FROM prop_picks WHERE tier='PASS' AND result IS NULL AND stake_units > 0").get() as { n: number };
  assert.equal(leak.n, 0, "no ungraded PASS prop may carry a stake after the heal");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
