// Unit tests for the prop edge math (spec §3): over/under probability from the
// simulated distribution with half-push handling, best multi-book price, and the
// edge_pp + surfacing gate. Standalone tsx harness using node:assert.
import assert from "node:assert/strict";
import {
  overUnderProb,
  bestPriceForSide,
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

test("computePropEdge: model favors over → side=over, positive edge vs -110", () => {
  // 70% over at -110 (implied ≈ 0.524) → edge ≈ +17.6pp
  const samples = [...Array(70).fill(1), ...Array(30).fill(0)];
  const edge = computePropEdge(dist(samples), 0.5, [{ book: "dk", overPrice: -110, underPrice: -110 }]);
  assert.ok(edge);
  assert.equal(edge!.side, "over");
  assert.equal(edge!.modelProb, 0.7);
  assert.ok(edge!.edgePp > 17 && edge!.edgePp < 18, `edgePp ${edge!.edgePp}`);
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

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
