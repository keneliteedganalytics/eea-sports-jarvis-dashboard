// Unit tests for the prop pick-builder's PURE decision functions (spec §5):
// tiering, the flat-stake + big-dog taper + +400 hard reject, the sample-size
// gate, data-quality tiering, ranking + daily cap of 8, confidence, market
// labels, and offer grouping (modal line across books). Standalone tsx harness.
import assert from "node:assert/strict";
import {
  assignPropTier,
  propStake,
  propStakeUnits,
  propConfidence,
  hasSufficientSample,
  dataQualityTier,
  rankAndCap,
  propRankScore,
  marketLabel,
  groupOffers,
  PROP_DAILY_CAP,
  PROP_MAX_AMERICAN,
  PROP_SNIPER_EDGE,
  PROP_EDGE_EDGE,
  PROP_RECON_EDGE,
  MIN_BATTER_LOGS,
  MIN_PITCHER_STARTS,
  type RankedProp,
} from "../sports/props/buildPropPicks";
import type { PropOfferRow } from "../gradedBook";

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

const aligned = { decided: 10, over: 6, rate: 0.6 };
const misaligned = { decided: 10, over: 3, rate: 0.3 };

console.log("prop pick builder");

// ── Constants ─────────────────────────────────────────────────────────────────

test("operating constants match spec", () => {
  assert.equal(PROP_DAILY_CAP, 8);
  assert.equal(PROP_MAX_AMERICAN, 400);
  assert.equal(PROP_SNIPER_EDGE, 8.0);
  assert.equal(PROP_EDGE_EDGE, 6.0);
  assert.equal(PROP_RECON_EDGE, 4.0);
  assert.equal(MIN_BATTER_LOGS, 20);
  assert.equal(MIN_PITCHER_STARTS, 8);
});

// ── Tiering ───────────────────────────────────────────────────────────────────

test("SNIPER: edge ≥ 8 AND L20 aligned AND data HIGH", () => {
  const t = assignPropTier({ edgePp: 9, side: "over", l10: aligned, l20: aligned, dataQualityTier: "HIGH" });
  assert.equal(t, "SNIPER");
});

test("not SNIPER when data is not HIGH (falls to EDGE if it qualifies)", () => {
  const t = assignPropTier({ edgePp: 9, side: "over", l10: aligned, l20: aligned, dataQualityTier: "MEDIUM" });
  assert.equal(t, "EDGE"); // edge ≥ 6 and L10 aligned
});

test("not SNIPER when L20 misaligned", () => {
  const t = assignPropTier({ edgePp: 9, side: "over", l10: aligned, l20: misaligned, dataQualityTier: "HIGH" });
  assert.equal(t, "EDGE");
});

test("EDGE: edge ≥ 6 AND L10 aligned", () => {
  const t = assignPropTier({ edgePp: 6.5, side: "over", l10: aligned, l20: aligned, dataQualityTier: "MEDIUM" });
  assert.equal(t, "EDGE");
});

test("edge ≥ 6 but L10 misaligned drops to RECON", () => {
  const t = assignPropTier({ edgePp: 6.5, side: "over", l10: misaligned, l20: aligned, dataQualityTier: "HIGH" });
  assert.equal(t, "RECON");
});

test("RECON: edge ≥ 4 regardless of alignment", () => {
  const t = assignPropTier({ edgePp: 4.5, side: "over", l10: misaligned, l20: misaligned, dataQualityTier: "LOW" });
  assert.equal(t, "RECON");
});

test("PASS: edge below the RECON floor", () => {
  const t = assignPropTier({ edgePp: 3.9, side: "over", l10: aligned, l20: aligned, dataQualityTier: "HIGH" });
  assert.equal(t, "PASS");
});

test("UNDER alignment uses ≤ 0.50", () => {
  // under with L10 rate 0.3 is aligned; edge 6.5 → EDGE
  const t = assignPropTier({ edgePp: 6.5, side: "under", l10: misaligned, l20: misaligned, dataQualityTier: "MEDIUM" });
  assert.equal(t, "EDGE");
});

// ── Stake + taper ─────────────────────────────────────────────────────────────

test("propStakeUnits defaults to 0.5", () => {
  const prev = process.env.PROP_STAKE_UNITS;
  delete process.env.PROP_STAKE_UNITS;
  assert.equal(propStakeUnits(), 0.5);
  if (prev !== undefined) process.env.PROP_STAKE_UNITS = prev;
});

test("propStakeUnits honors a valid env override", () => {
  const prev = process.env.PROP_STAKE_UNITS;
  process.env.PROP_STAKE_UNITS = "0.75";
  assert.equal(propStakeUnits(), 0.75);
  if (prev === undefined) delete process.env.PROP_STAKE_UNITS;
  else process.env.PROP_STAKE_UNITS = prev;
});

test("propStake: flat 0.5u at a short favorite price (no taper)", () => {
  const s = propStake(-150);
  assert.equal(s.rejected, false);
  assert.equal(s.units, 0.5);
});

test("propStake: hard reject above +400", () => {
  const s = propStake(401);
  assert.equal(s.rejected, true);
  assert.equal(s.units, 0);
});

test("propStake: +400 exactly is allowed (boundary)", () => {
  const s = propStake(400);
  assert.equal(s.rejected, false);
});

test("propStake: big-dog taper shrinks the stake on a long price", () => {
  const short = propStake(120).units;
  const long = propStake(350).units;
  assert.ok(long <= short, `long ${long} should be ≤ short ${short}`);
});

// ── Sample-size gate ──────────────────────────────────────────────────────────

test("batter needs ≥ 20 logs", () => {
  assert.equal(hasSufficientSample("batter_hits", 20, 0), true);
  assert.equal(hasSufficientSample("batter_hits", 19, 0), false);
});

test("pitcher needs ≥ 8 starts", () => {
  assert.equal(hasSufficientSample("pitcher_strikeouts", 0, 8), true);
  assert.equal(hasSufficientSample("pitcher_strikeouts", 0, 7), false);
});

// ── Data quality ──────────────────────────────────────────────────────────────

test("HIGH: full window + season anchor", () => {
  assert.equal(dataQualityTier("batter_hits", 20, true), "HIGH");
});
test("MEDIUM: at least half the minimum logs", () => {
  assert.equal(dataQualityTier("batter_hits", 10, false), "MEDIUM");
});
test("LOW: thin sample", () => {
  assert.equal(dataQualityTier("batter_hits", 5, false), "LOW");
});
test("HIGH requires the season anchor even at full logs", () => {
  assert.equal(dataQualityTier("batter_hits", 20, false), "MEDIUM");
});
test("pitcher data quality uses the start minimum", () => {
  assert.equal(dataQualityTier("pitcher_strikeouts", 8, true), "HIGH");
  assert.equal(dataQualityTier("pitcher_strikeouts", 4, false), "MEDIUM");
});

// ── Ranking + cap ─────────────────────────────────────────────────────────────

function ranked(id: string, tier: RankedProp["tier"], edgePp: number, confidence = 70, sampleSize = 25): RankedProp {
  return { pickId: id, tier, edgePp, confidence, sampleSize };
}

test("rankAndCap drops PASS picks", () => {
  const out = rankAndCap([ranked("a", "PASS", 3), ranked("b", "RECON", 5)]);
  assert.equal(out.length, 1);
  assert.equal(out[0].pickId, "b");
});

test("rankAndCap orders SNIPER before EDGE before RECON", () => {
  const out = rankAndCap([
    ranked("r", "RECON", 9, 85, 100),
    ranked("s", "SNIPER", 4, 50, 20),
    ranked("e", "EDGE", 7, 70, 50),
  ]);
  assert.deepEqual(out.map((p) => p.pickId), ["s", "e", "r"]);
});

test("within a tier, higher rank score wins", () => {
  const out = rankAndCap([
    ranked("lo", "RECON", 4, 55, 20),
    ranked("hi", "RECON", 9, 80, 100),
  ]);
  assert.equal(out[0].pickId, "hi");
});

test("daily cap holds at 8 actionable picks", () => {
  const picks = Array.from({ length: 15 }, (_, i) => ranked(`p${i}`, "RECON", 5 + (i % 3)));
  const out = rankAndCap(picks);
  assert.equal(out.length, PROP_DAILY_CAP);
});

test("rankAndCap respects an explicit smaller cap", () => {
  const picks = Array.from({ length: 10 }, (_, i) => ranked(`p${i}`, "EDGE", 6));
  assert.equal(rankAndCap(picks, 3).length, 3);
});

test("propRankScore = edge × confidence × sqrt(sample)", () => {
  const s = propRankScore({ pickId: "x", tier: "EDGE", edgePp: 6, confidence: 70, sampleSize: 25 });
  assert.ok(Math.abs(s - 6 * 70 * 5) < 1e-9);
});

// ── Confidence ────────────────────────────────────────────────────────────────

test("propConfidence is bounded 50..85", () => {
  assert.ok(propConfidence(0, 0.5) >= 50);
  assert.ok(propConfidence(100, 0.99) <= 85);
});

test("propConfidence rises with edge and prob distance from 0.5", () => {
  assert.ok(propConfidence(10, 0.7) > propConfidence(2, 0.52));
});

// ── Market labels ─────────────────────────────────────────────────────────────

test("marketLabel maps known markets to display labels", () => {
  assert.equal(marketLabel("batter_hits"), "HITS");
  assert.equal(marketLabel("pitcher_strikeouts"), "STRIKEOUTS");
  assert.equal(marketLabel("batter_total_bases"), "TOTAL BASES");
});

test("marketLabel falls back to a humanized key for unknowns", () => {
  assert.equal(marketLabel("batter_doubles"), "BATTER DOUBLES");
});

// ── Offer grouping ────────────────────────────────────────────────────────────

function offer(book: string, line: number, over: Partial<PropOfferRow> = {}): PropOfferRow {
  return {
    event_id: "evt1", sport: "mlb", game_date: "2026-06-11", player_name: "Judge", player_id: null,
    team: null, market: "batter_hits", line, over_price: -110, under_price: -110, book,
    fetched_at: "2026-06-10T12:00:00Z", ...over,
  };
}

test("groupOffers collapses books into one quote set per (event,player,market)", () => {
  const grouped = groupOffers([offer("dk", 0.5), offer("fd", 0.5), offer("mgm", 0.5)]);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].quotes.length, 3);
  assert.equal(grouped[0].player, "Judge");
});

test("groupOffers keys the modal line across books", () => {
  // two books at 1.5, one at 0.5 → modal 1.5
  const grouped = groupOffers([offer("dk", 1.5), offer("fd", 1.5), offer("mgm", 0.5)]);
  assert.equal(grouped[0].line, 1.5);
});

test("groupOffers separates distinct players and markets", () => {
  const grouped = groupOffers([
    offer("dk", 0.5),
    offer("dk", 0.5, { player_name: "Soto" }),
    offer("dk", 5.5, { market: "pitcher_strikeouts", player_name: "Cole" }),
  ]);
  assert.equal(grouped.length, 3);
});

test("groupOffers carries best/over/under prices through as quotes", () => {
  const grouped = groupOffers([offer("dk", 0.5, { over_price: -105, under_price: -115 })]);
  assert.equal(grouped[0].quotes[0].overPrice, -105);
  assert.equal(grouped[0].quotes[0].underPrice, -115);
  assert.equal(grouped[0].quotes[0].book, "dk");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
