// Unit tests for the prop edge math (spec §3): over/under probability from the
// simulated distribution with half-push handling, best multi-book price, and the
// edge_pp + surfacing gate. Standalone tsx harness using node:assert.
import assert from "node:assert/strict";
import {
  overUnderProb,
  bestPriceForSide,
  fairProbForQuote,
  bestFairForSide,
  computePropEdge,
  qualifiesAsPick,
  PROP_EDGE_FLOOR_PP,
  PROP_MIN_MODEL_PROB,
  type BookQuote,
} from "../sports/props/edge";
import type { SimDistribution } from "../sports/props/simulate";

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

// Build a SimDistribution from a raw sample array (sorted, like summarize()).
function dist(samples: number[]): SimDistribution {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.reduce((s, v) => s + v, 0) / Math.max(1, sorted.length);
  return {
    trials: sorted.length,
    median: sorted[Math.floor(0.5 * (sorted.length - 1))] ?? 0,
    p25: sorted[Math.floor(0.25 * (sorted.length - 1))] ?? 0,
    p75: sorted[Math.floor(0.75 * (sorted.length - 1))] ?? 0,
    mean: Math.round(mean * 1000) / 1000,
    samples: sorted,
  };
}

console.log("prop edge math");

test("overUnderProb: clean split above/below a non-integer line", () => {
  // line 0.5: values 1,1,1,0,0 → 3 over, 2 under, 0 on
  const ou = overUnderProb(dist([1, 1, 1, 0, 0]), 0.5);
  assert.equal(ou.probOver, 0.6);
  assert.equal(ou.probUnder, 0.4);
  assert.equal(ou.pushProb, 0);
});

test("overUnderProb: exact-line trials are half-push (split evenly)", () => {
  // line 1: values 2,2 over; 0,0 under; 1,1 on → over=(2+1)/6, under=(2+1)/6
  const ou = overUnderProb(dist([2, 2, 0, 0, 1, 1]), 1);
  assert.equal(ou.probOver, 0.5);
  assert.equal(ou.probUnder, 0.5);
  assert.equal(ou.pushProb, round4(2 / 6));
});

test("overUnderProb: all on the line → 50/50 with full push share", () => {
  const ou = overUnderProb(dist([1, 1, 1, 1]), 1);
  assert.equal(ou.probOver, 0.5);
  assert.equal(ou.probUnder, 0.5);
  assert.equal(ou.pushProb, 1);
});

test("overUnderProb: empty distribution → zeros", () => {
  const ou = overUnderProb(dist([]), 0.5);
  assert.equal(ou.probOver, 0);
  assert.equal(ou.probUnder, 0);
  assert.equal(ou.pushProb, 0);
});

test("overUnderProb: probOver + probUnder sum to 1 when no pushes", () => {
  const ou = overUnderProb(dist([3, 2, 1, 0, 4, 5, 2, 1]), 1.5);
  assert.ok(Math.abs(ou.probOver + ou.probUnder - 1) < 1e-9);
});

test("overUnderProb: with pushes, over+under still sum to 1 (half-push convention)", () => {
  const ou = overUnderProb(dist([2, 2, 0, 0, 1, 1, 1, 1]), 1);
  assert.ok(Math.abs(ou.probOver + ou.probUnder - 1) < 1e-9);
});

test("bestPriceForSide: picks the highest (most favorable) over price", () => {
  const quotes: BookQuote[] = [
    { book: "dk", overPrice: -120, underPrice: 100 },
    { book: "fd", overPrice: -105, underPrice: -115 },
    { book: "mgm", overPrice: -110, underPrice: -110 },
  ];
  const best = bestPriceForSide(quotes, "over");
  assert.equal(best?.book, "fd");
  assert.equal(best?.price, -105);
});

test("bestPriceForSide: picks the highest under price", () => {
  const quotes: BookQuote[] = [
    { book: "dk", overPrice: -120, underPrice: 100 },
    { book: "fd", overPrice: -105, underPrice: 120 },
  ];
  const best = bestPriceForSide(quotes, "under");
  assert.equal(best?.book, "fd");
  assert.equal(best?.price, 120);
});

test("bestPriceForSide: skips null prices", () => {
  const quotes: BookQuote[] = [
    { book: "dk", overPrice: null, underPrice: -110 },
    { book: "fd", overPrice: -130, underPrice: null },
  ];
  assert.equal(bestPriceForSide(quotes, "over")?.book, "fd");
  assert.equal(bestPriceForSide(quotes, "under")?.book, "dk");
});

test("bestPriceForSide: no priced books → null", () => {
  const quotes: BookQuote[] = [{ book: "dk", overPrice: null, underPrice: null }];
  assert.equal(bestPriceForSide(quotes, "over"), null);
});

test("computePropEdge: model favors over → side=over, edge vs no-vig fair", () => {
  // 70% over at -110/-110. Both sides priced → devig: raw .5238 each, fair .5 each.
  // edge = (0.70 − 0.50) × 100 = +20.0pp (was +17.6 against the raw .524).
  const samples = [...Array(70).fill(1), ...Array(30).fill(0)];
  const edge = computePropEdge(dist(samples), 0.5, [{ book: "dk", overPrice: -110, underPrice: -110 }]);
  assert.ok(edge);
  assert.equal(edge!.side, "over");
  assert.equal(edge!.modelProb, 0.7);
  assert.ok(Math.abs(edge!.edgePp - 20) < 0.05, `edgePp ${edge!.edgePp}`);
  assert.ok(Math.abs(edge!.impliedProb - 0.5) < 1e-3, `fair ${edge!.impliedProb}`);
});

test("computePropEdge: model favors under when under prob higher", () => {
  const samples = [...Array(20).fill(1), ...Array(80).fill(0)];
  const edge = computePropEdge(dist(samples), 0.5, [{ book: "dk", overPrice: -110, underPrice: -110 }]);
  assert.equal(edge!.side, "under");
  assert.equal(edge!.modelProb, 0.8);
});

test("computePropEdge: ties go to over (probOver >= probUnder)", () => {
  const samples = [...Array(50).fill(1), ...Array(50).fill(0)];
  const edge = computePropEdge(dist(samples), 0.5, [{ book: "dk", overPrice: 100, underPrice: 100 }]);
  assert.equal(edge!.side, "over");
});

test("computePropEdge: returns null when chosen side has no price", () => {
  const samples = [...Array(70).fill(1), ...Array(30).fill(0)];
  const edge = computePropEdge(dist(samples), 0.5, [{ book: "dk", overPrice: null, underPrice: -110 }]);
  assert.equal(edge, null);
});

test("computePropEdge: shops best price across books for the chosen side", () => {
  const samples = [...Array(70).fill(1), ...Array(30).fill(0)];
  const edge = computePropEdge(dist(samples), 0.5, [
    { book: "dk", overPrice: -130, underPrice: 100 },
    { book: "fd", overPrice: +105, underPrice: -125 },
  ]);
  assert.equal(edge!.bestBook, "fd");
  assert.equal(edge!.bestPrice, 105);
});

test("qualifiesAsPick: passes when edge ≥ floor, prob ≥ 0.5, dq not LOW", () => {
  const edge = computePropEdge(
    dist([...Array(70).fill(1), ...Array(30).fill(0)]),
    0.5,
    [{ book: "dk", overPrice: -110, underPrice: -110 }],
  )!;
  assert.equal(qualifiesAsPick(edge, "HIGH"), true);
  assert.equal(qualifiesAsPick(edge, "MEDIUM"), true);
});

test("qualifiesAsPick: rejected when data quality is LOW", () => {
  const edge = computePropEdge(
    dist([...Array(70).fill(1), ...Array(30).fill(0)]),
    0.5,
    [{ book: "dk", overPrice: -110, underPrice: -110 }],
  )!;
  assert.equal(qualifiesAsPick(edge, "LOW"), false);
  assert.equal(qualifiesAsPick(edge, "low"), false);
});

test("qualifiesAsPick: rejected when edge below the 4.0pp floor", () => {
  // 53% over at -110 (implied .524) → edge ≈ +0.6pp, below floor
  const edge = computePropEdge(
    dist([...Array(53).fill(1), ...Array(47).fill(0)]),
    0.5,
    [{ book: "dk", overPrice: -110, underPrice: -110 }],
  )!;
  assert.ok(edge.edgePp < PROP_EDGE_FLOOR_PP);
  assert.equal(qualifiesAsPick(edge, "HIGH"), false);
});

test("constants: floor 4.0pp, min model prob 0.5", () => {
  assert.equal(PROP_EDGE_FLOOR_PP, 4.0);
  assert.equal(PROP_MIN_MODEL_PROB, 0.5);
});

// ── No-vig (devigged) fair probability (v6.7.4 BUG #3) ───────────────────────

test("fairProbForQuote: single-side market falls back to raw implied", () => {
  // Only the under is priced → no opposing side to devig against → raw implied.
  // under +195 → raw implied = 100/295 ≈ 0.3390.
  const q: BookQuote = { book: "dk", overPrice: null, underPrice: 195 };
  const fair = fairProbForQuote(q, "under")!;
  assert.ok(Math.abs(fair - 0.339) < 1e-3, `fair ${fair}`);
});

test("fairProbForQuote: both sides → normalized no-vig fair prob", () => {
  // over -150 / under +130. raw over = 150/250 = 0.60, raw under = 100/230 ≈ 0.4348.
  // total ≈ 1.0348. fair over = 0.60/1.0348 ≈ 0.5798; fair under ≈ 0.4202.
  const q: BookQuote = { book: "dk", overPrice: -150, underPrice: 130 };
  const fairOver = fairProbForQuote(q, "over")!;
  const fairUnder = fairProbForQuote(q, "under")!;
  assert.ok(Math.abs(fairOver - 0.5798) < 2e-3, `fairOver ${fairOver}`);
  assert.ok(Math.abs(fairUnder - 0.4202) < 2e-3, `fairUnder ${fairUnder}`);
  assert.ok(Math.abs(fairOver + fairUnder - 1) < 1e-9, "fair probs sum to 1");
});

test("fairProbForQuote: picked side missing → null", () => {
  assert.equal(fairProbForQuote({ book: "dk", overPrice: -110, underPrice: null }, "under"), null);
});

test("bestFairForSide: line-shops the LOWEST fair prob, not the best raw price", () => {
  // For the under: book A under +130 paired with over -150 devigs to fair ≈ 0.4202.
  // Book B under +140 (better raw price) paired with a juiced over -200 devigs to
  // a HIGHER fair: raw under = 100/240 ≈ 0.4167, raw over = 200/300 ≈ 0.6667,
  // total ≈ 1.0833, fair under ≈ 0.3846 — that's actually LOWER. So B wins on fair
  // prob (cheaper after vig) AND happens to have the better raw price here; flip it:
  // Book C under +120 / over -110: raw under = 100/220 ≈ 0.4545, raw over ≈ 0.5238,
  // total ≈ 0.9783, fair under ≈ 0.4646 — higher fair (worse). Pick the lowest fair.
  const quotes: BookQuote[] = [
    { book: "A", overPrice: -150, underPrice: 130 }, // fair under ≈ 0.4202
    { book: "B", overPrice: -200, underPrice: 140 }, // fair under ≈ 0.3846 ← lowest
    { book: "C", overPrice: -110, underPrice: 120 }, // fair under ≈ 0.4646
  ];
  const best = bestFairForSide(quotes, "under")!;
  assert.equal(best.book, "B");
  assert.equal(best.price, 140);
  assert.ok(Math.abs(best.fairProb - 0.3846) < 2e-3, `fair ${best.fairProb}`);
});

test("bestFairForSide: raw-best-price book is NOT chosen when its fair prob is worse", () => {
  // HI has the highest raw under price (+200) but a lightly-vigged over (-110), so
  // its fair under is high. LO has a worse raw under price (+120) but a heavily
  // vigged over (-350), pushing its fair under LOWER. We must line-shop on fair
  // (LO), even though HI has the better raw price — proving fair, not raw, drives it.
  // HI: raw under = 100/300 ≈ 0.3333, raw over ≈ 0.5238, total ≈ 0.8571, fair ≈ 0.3889.
  // LO: raw under = 100/220 ≈ 0.4545, raw over = 350/450 ≈ 0.7778, total ≈ 1.2323, fair ≈ 0.3689.
  const quotes: BookQuote[] = [
    { book: "HI", overPrice: -110, underPrice: 200 },
    { book: "LO", overPrice: -350, underPrice: 120 },
  ];
  const bestRaw = bestPriceForSide(quotes, "under")!;
  const bestFair = bestFairForSide(quotes, "under")!;
  assert.equal(bestRaw.book, "HI"); // highest raw price
  assert.equal(bestFair.book, "LO"); // lowest fair prob (diverges from raw)
  assert.ok(Math.abs(bestFair.fairProb - 0.3689) < 2e-3, `fair ${bestFair.fairProb}`);
});

test("computePropEdge: under edge uses no-vig fair (the inflation fix)", () => {
  // Hand-computed sanity: over -150 / under +130 → fair under ≈ 0.4202 (raw single-
  // side +130 implies 0.4348). Model puts 60% on the under (60 below the 1.5 line):
  //   no-vig edge = 60 − 42.02 = +17.98pp
  //   raw-implied edge would have been 60 − 43.48 = +16.52pp (the inflated path)
  const samples = [...Array(60).fill(0), ...Array(40).fill(2)]; // 60% under a 1.5 line
  const edge = computePropEdge(dist(samples), 1.5, [{ book: "dk", overPrice: -150, underPrice: 130 }]);
  assert.ok(edge);
  assert.equal(edge!.side, "under");
  assert.equal(edge!.modelProb, 0.6);
  assert.ok(Math.abs(edge!.impliedProb - 0.4202) < 2e-3, `fair ${edge!.impliedProb}`);
  assert.ok(Math.abs(edge!.edgePp - 17.98) < 0.1, `edgePp ${edge!.edgePp} (expected ≈ +17.98 no-vig)`);
  // Prove it is NOT the raw single-side number.
  assert.ok(Math.abs(edge!.edgePp - 16.52) > 1, "edge must not equal the raw-implied 16.52pp");
});

test("computePropEdge: single-side under quote uses raw implied (no devig available)", () => {
  // Only the under is priced. +195 → raw 0.3390. 60% under model → edge = 60 − 33.90 = +26.1pp.
  // This is the inflation the no-vig fix removes WHEN both sides exist; with one side
  // there is nothing to devig against, so raw implied is the honest best estimate.
  const samples = [...Array(60).fill(0), ...Array(40).fill(2)];
  const edge = computePropEdge(dist(samples), 1.5, [{ book: "dk", overPrice: null, underPrice: 195 }]);
  assert.ok(edge);
  assert.equal(edge!.side, "under");
  assert.ok(Math.abs(edge!.impliedProb - 0.339) < 1e-3, `fair ${edge!.impliedProb}`);
  assert.ok(Math.abs(edge!.edgePp - 26.1) < 0.2, `edgePp ${edge!.edgePp}`);
});

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
