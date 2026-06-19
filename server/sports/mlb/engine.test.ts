// Unit tests for the locked betting math. Run with: npm test
// Standalone tsx harness (no jest/vitest) using node:assert.
import assert from "node:assert/strict";
import { americanToProb } from "../../core/odds";
import { assignTier } from "../../core/tier";
import { kellyFraction, computeKellyStake, KELLY_CAP_PCT } from "../../core/kelly";
import { resolveGapTrap, buildPick, type GameInput } from "./picksEngine";
import { predictGame as predictMlb } from "./model";

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

console.log("betting math");

test("americanToProb(-150) ≈ 0.60", () => {
  const p = americanToProb(-150);
  assert.notEqual(p, null);
  assert.ok(Math.abs((p as number) - 0.6) < 0.001, `got ${p}`);
});

test("assignTier(edge=8.5, conf=82) → SNIPER", () => {
  const tier = assignTier({ edgePp: 8.5, confidence: 82 });
  assert.equal(tier, "SNIPER");
});

test("assignTier(edge=5.5, conf=60) → EDGE", () => {
  assert.equal(assignTier({ edgePp: 5.5, confidence: 60 }), "EDGE");
});

test("assignTier(edge=3.5, conf=52) → RECON", () => {
  assert.equal(assignTier({ edgePp: 3.5, confidence: 52 }), "RECON");
});

test("assignTier(edge=2.0, conf=80) → PASS (below RECON edge floor)", () => {
  assert.equal(assignTier({ edgePp: 2.0, confidence: 80 }), "PASS");
});

test("kellyFraction(0.55, -110) > 0", () => {
  const f = kellyFraction(0.55, -110);
  assert.ok(f > 0, `expected positive, got ${f}`);
});

test("quarter-Kelly cap respected (≤ 3% bankroll)", () => {
  // A monster edge would blow past the cap at full Kelly; quarter-Kelly + cap clamps it.
  const r = computeKellyStake(0.95, -110, 10000);
  assert.ok(r.finalFraction <= KELLY_CAP_PCT + 1e-9, `fraction ${r.finalFraction} exceeds cap ${KELLY_CAP_PCT}`);
  assert.ok(r.capped, "expected capped flag to be set on an oversized edge");
  assert.ok(r.stakeDollars <= 10000 * KELLY_CAP_PCT + 0.01, `stake ${r.stakeDollars} exceeds 3% of bankroll`);
});

// ── v6.11.1 sharp-aligned gap-trap override ────────────────────────────────
console.log("v6.11.1 gap-trap override");

test("resolveGapTrap: trap fires + MODEL aligns with sharp side → recon_override", () => {
  // TOR @ BOS shape: 30pp public/sharp gap, but MODEL (0.58) sits with the SHARP
  // side (0.55) and away from the PUBLIC side (0.28). Structural dispersion, not a
  // real trap — should override to a RECON flier instead of PASS.
  const outcome = resolveGapTrap({
    trapFired: true,
    otherGateFired: false,
    modelProb: 0.58,
    sharpPct: 55,
    publicPct: 28,
  });
  assert.equal(outcome, "recon_override", `expected recon_override, got ${outcome}`);
});

test("resolveGapTrap: trap fires + MODEL leans the public/rec side → pass (real trap)", () => {
  // Same 27pp gap, but now MODEL (0.30) hugs the PUBLIC side (0.28) and is far from
  // the SHARP side (0.55). That is the genuine trap shape — keep PASS.
  const outcome = resolveGapTrap({
    trapFired: true,
    otherGateFired: false,
    modelProb: 0.30,
    sharpPct: 55,
    publicPct: 28,
  });
  assert.equal(outcome, "pass", `expected pass, got ${outcome}`);
});

test("resolveGapTrap: no trap → clear; other hard gate fired → pass; missing data → pass", () => {
  assert.equal(
    resolveGapTrap({ trapFired: false, otherGateFired: false, modelProb: 0.58, sharpPct: 55, publicPct: 28 }),
    "clear",
  );
  // Even sharp-aligned, a second independent hard gate keeps the PASS.
  assert.equal(
    resolveGapTrap({ trapFired: true, otherGateFired: true, modelProb: 0.58, sharpPct: 55, publicPct: 28 }),
    "pass",
  );
  // Missing sharp/public/model data → cannot prove sharp alignment → stay PASS.
  assert.equal(
    resolveGapTrap({ trapFired: true, otherGateFired: false, modelProb: 0.58, sharpPct: null, publicPct: 28 }),
    "pass",
  );
});

test("Integration: buildPick attaches a valid gapTrapOutcome to every MLB pick", () => {
  const game: GameInput = {
    gameId: "gaptrap-present-test",
    gameDate: "2025-07-10",
    gameTimeEt: "7:10 PM ET",
    venue: "Wrigley Field",
    homeTeam: "CHC",
    awayTeam: "COL",
    homeTeamFull: "Chicago Cubs",
    awayTeamFull: "Colorado Rockies",
    mlHome: -150,
    mlAway: 130,
    homeFairProb: 0.6,
    awayFairProb: 0.4,
    homeSpStats: { available: true, pitcher: "P1", era: 4.0, fip: 3.9, ip: 80 },
    awaySpStats: { available: true, pitcher: "P2", era: 4.5, fip: 4.4, ip: 75 },
    homeOffStats: { ops: 0.74 },
    awayOffStats: { ops: 0.70 },
  };
  const model = predictMlb({
    homeTeam: "CHC",
    awayTeam: "COL",
    homeTeamFull: "Chicago Cubs",
    awayTeamFull: "Colorado Rockies",
    homeSpStats: { available: true, pitcher: "P1", era: 4.0, fip: 3.9, ip: 80 },
    awaySpStats: { available: true, pitcher: "P2", era: 4.5, fip: 4.4, ip: 75 },
    homeOffStats: { ops: 0.74 },
    awayOffStats: { ops: 0.70 },
    venueTriCode: "CHC",
    homeFairProb: 0.6,
    awayFairProb: 0.4,
  });
  const pick = buildPick(game, model);
  assert.ok(
    ["clear", "pass", "recon_override"].includes(pick.gapTrapOutcome),
    `gapTrapOutcome must be one of clear/pass/recon_override, got ${pick.gapTrapOutcome}`,
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
