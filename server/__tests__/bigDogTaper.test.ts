// Big-dog stake taper (v6.6). Verifies each odds band and the boundary edges.
// Run: tsx server/__tests__/bigDogTaper.test.ts

import assert from "node:assert/strict";
import {
  taperBigDogStake,
  tapeBigDogStake,
  bigDogTaperFactor,
} from "../sports/units";

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

console.log("big-dog stake taper — v6.6");

// ── Band 1: +100..+200 → ×1.0 (full units) ──────────────────────────
test("favorites and short dogs (≤ +200) keep full units", () => {
  assert.equal(taperBigDogStake(2.0, -150), 2.0);
  assert.equal(taperBigDogStake(2.0, 100), 2.0);
  assert.equal(taperBigDogStake(2.0, 200), 2.0);
  assert.equal(bigDogTaperFactor(150), 1.0);
});

// ── Band 2: +201..+400 → ×0.50 ──────────────────────────────────────
test("+201..+400 halves the stake", () => {
  assert.equal(taperBigDogStake(2.0, 201), 1.0);
  assert.equal(taperBigDogStake(2.0, 300), 1.0);
  assert.equal(taperBigDogStake(2.0, 400), 1.0);
  assert.equal(bigDogTaperFactor(300), 0.5);
});

// ── Band 3: +401..+600 → ×0.25 ──────────────────────────────────────
test("+401..+600 quarters the stake", () => {
  assert.equal(taperBigDogStake(2.0, 401), 0.5);
  assert.equal(taperBigDogStake(2.0, 500), 0.5);
  assert.equal(taperBigDogStake(2.0, 600), 0.5);
  assert.equal(bigDogTaperFactor(500), 0.25);
});

// ── Band 4: +601..+1000 → ×0.10 ─────────────────────────────────────
test("+601..+1000 tenths the stake", () => {
  assert.equal(taperBigDogStake(2.0, 601), 0.2);
  assert.equal(taperBigDogStake(2.0, 1000), 0.2);
  assert.equal(bigDogTaperFactor(800), 0.1);
});

// ── Band 5: +1001 and up → ×0.0 (hard reject) ───────────────────────
test("+1001 and longer is hard-rejected to 0 units", () => {
  assert.equal(taperBigDogStake(2.0, 1001), 0);
  assert.equal(taperBigDogStake(2.5, 3000), 0);
  assert.equal(bigDogTaperFactor(1060), 0.0);
  assert.equal(bigDogTaperFactor(3000), 0.0);
});

// ── Boundary edges: exact band cutovers ─────────────────────────────
test("exact boundary values land in the lower (more generous) band", () => {
  assert.equal(bigDogTaperFactor(200), 1.0); // +200 still full
  assert.equal(bigDogTaperFactor(201), 0.5); // +201 halved
  assert.equal(bigDogTaperFactor(400), 0.5);
  assert.equal(bigDogTaperFactor(401), 0.25);
  assert.equal(bigDogTaperFactor(600), 0.25);
  assert.equal(bigDogTaperFactor(601), 0.1);
  assert.equal(bigDogTaperFactor(1000), 0.1);
  assert.equal(bigDogTaperFactor(1001), 0.0);
});

test("tonight's four dogs (+430,+560,+1060,+3000) all taper hard", () => {
  assert.equal(taperBigDogStake(2.0, 430), 0.5); // ×0.25
  assert.equal(taperBigDogStake(2.0, 560), 0.5); // ×0.25
  assert.equal(taperBigDogStake(2.0, 1060), 0); // reject
  assert.equal(taperBigDogStake(2.0, 3000), 0); // reject
});

test("tapeBigDogStake alias matches taperBigDogStake", () => {
  assert.equal(tapeBigDogStake(2.0, 300), taperBigDogStake(2.0, 300));
  assert.equal(tapeBigDogStake(2.0, 3000), 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
