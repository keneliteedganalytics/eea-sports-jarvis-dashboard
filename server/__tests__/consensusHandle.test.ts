// Fix 4: PublicHandlePct / SharpHandlePct + handleVsBetDivergence.
// Tests: handle field absent → nulls; handle field present → populated;
//        divergence >10pp signals sharp money.
// Run: tsx server/__tests__/consensusHandle.test.ts

import assert from "node:assert/strict";
import {
  computePublicSharp,
  handleVsBetDivergence,
  type RawBookmaker,
} from "../core/consensus";

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

const HOME = "New York Yankees";
const AWAY = "Boston Red Sox";

// Bookmakers with normal prices but NO handle_pct fields
const bmNoHandle: RawBookmaker[] = [
  {
    key: "draftkings",
    markets: [
      {
        key: "h2h",
        outcomes: [
          { name: HOME, price: -130 },
          { name: AWAY, price: 110 },
        ],
      },
    ],
  },
  {
    key: "pinnacle",
    markets: [
      {
        key: "h2h",
        outcomes: [
          { name: HOME, price: -125 },
          { name: AWAY, price: 105 },
        ],
      },
    ],
  },
];

// Bookmakers WITH handle_pct (premium tier)
const bmWithHandle: RawBookmaker[] = [
  {
    key: "draftkings",
    markets: [
      {
        key: "h2h",
        outcomes: [
          { name: HOME, price: -130, handle_pct: 70, bet_pct: 55 },
          { name: AWAY, price: 110,  handle_pct: 30, bet_pct: 45 },
        ],
      },
    ],
  },
  {
    key: "fanduel",
    markets: [
      {
        key: "h2h",
        outcomes: [
          { name: HOME, price: -128, handle_pct: 65, bet_pct: 52 },
          { name: AWAY, price: 108,  handle_pct: 35, bet_pct: 48 },
        ],
      },
    ],
  },
  {
    key: "pinnacle",
    markets: [
      {
        key: "h2h",
        outcomes: [
          { name: HOME, price: -125, handle_pct: 72, bet_pct: 50 },
          { name: AWAY, price: 105,  handle_pct: 28, bet_pct: 50 },
        ],
      },
    ],
  },
];

console.log("Fix 4 — consensus handle fields + handleVsBetDivergence");

// ── Handle disabled (env var absent or not "true") ────────────────────────
test("handle fields are null when ODDS_API_HANDLE_ENABLED is not set", () => {
  delete process.env.ODDS_API_HANDLE_ENABLED;
  const r = computePublicSharp(bmNoHandle, HOME, AWAY);
  assert.equal(r.publicHandlePct, null, "publicHandlePct should be null");
  assert.equal(r.sharpHandlePct, null, "sharpHandlePct should be null");
});

test("handle fields are null when ODDS_API_HANDLE_ENABLED=false", () => {
  process.env.ODDS_API_HANDLE_ENABLED = "false";
  const r = computePublicSharp(bmNoHandle, HOME, AWAY);
  assert.equal(r.publicHandlePct, null);
  assert.equal(r.sharpHandlePct, null);
});

test("handle fields null when flag off even if books carry handle_pct data", () => {
  process.env.ODDS_API_HANDLE_ENABLED = "false";
  const r = computePublicSharp(bmWithHandle, HOME, AWAY);
  assert.equal(r.publicHandlePct, null);
  assert.equal(r.sharpHandlePct, null);
});

test("handle fields null when flag is on but books carry no handle_pct", () => {
  process.env.ODDS_API_HANDLE_ENABLED = "true";
  const r = computePublicSharp(bmNoHandle, HOME, AWAY);
  assert.equal(r.publicHandlePct, null);
  assert.equal(r.sharpHandlePct, null);
});

// ── Handle enabled ────────────────────────────────────────────────────────
test("publicHandlePct populated when flag on and data present", () => {
  process.env.ODDS_API_HANDLE_ENABLED = "true";
  const r = computePublicSharp(bmWithHandle, HOME, AWAY);
  assert.ok(r.publicHandlePct !== null, "publicHandlePct should not be null");
  // Average of DK (70) and FD (65) = 67.5
  assert.equal(r.publicHandlePct, 67.5);
});

test("sharpHandlePct populated from Pinnacle when flag on and data present", () => {
  process.env.ODDS_API_HANDLE_ENABLED = "true";
  const r = computePublicSharp(bmWithHandle, HOME, AWAY);
  assert.ok(r.sharpHandlePct !== null, "sharpHandlePct should not be null");
  assert.equal(r.sharpHandlePct, 72);
});

test("publicPct and sharpPct still populated correctly with handle data", () => {
  process.env.ODDS_API_HANDLE_ENABLED = "true";
  const r = computePublicSharp(bmWithHandle, HOME, AWAY);
  assert.ok(r.publicPct !== null, "publicPct should still be populated");
  assert.ok(r.sharpPct !== null, "sharpPct should still be populated");
});

// ── handleVsBetDivergence ─────────────────────────────────────────────────
test("handleVsBetDivergence: null inputs → null", () => {
  assert.equal(handleVsBetDivergence(null, 50), null);
  assert.equal(handleVsBetDivergence(50, null), null);
  assert.equal(handleVsBetDivergence(null, null), null);
  assert.equal(handleVsBetDivergence(undefined, undefined), null);
});

test("handleVsBetDivergence: handle > bet by >10pp → divergence > 10", () => {
  const div = handleVsBetDivergence(70, 55);
  assert.ok(div !== null);
  assert.equal(div, 15);
  assert.ok(div! > 10, `expected divergence > 10pp, got ${div}`);
});

test("handleVsBetDivergence: handle ≈ bet → small or zero divergence", () => {
  const div = handleVsBetDivergence(52, 50);
  assert.ok(div !== null);
  assert.equal(div, 2);
  assert.ok(div! <= 10, `expected small divergence, got ${div}`);
});

test("handleVsBetDivergence: returns signed value (handle < bet → negative)", () => {
  const div = handleVsBetDivergence(40, 55);
  assert.ok(div !== null);
  assert.equal(div, -15);
});

// cleanup
delete process.env.ODDS_API_HANDLE_ENABLED;

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
