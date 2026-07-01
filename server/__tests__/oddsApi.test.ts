// v6.14.0 — odds sanity. Covers isValidH2HQuote (the structural quote guard that
// keeps DFS/placeholder garbage out of consensus) and consensusSnhl's quorum
// flag + PROPS_ONLY_BOOKS exclusion + book-level vig drop.
// Run: tsx server/__tests__/oddsApi.test.ts

import assert from "node:assert/strict";
import { isValidH2HQuote } from "../adapters/oddsApi";
import { consensusSnhl, type Bookmaker } from "../core/odds";

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

function book(key: string, home: number, away: number): Bookmaker {
  return {
    key,
    markets: [{ key: "h2h", outcomes: [{ name: "HOME", price: home }, { name: "AWAY", price: away }] }],
  };
}

console.log("oddsApi — v6.14.0 quote validator + consensus quorum");

// ---- isValidH2HQuote ----

test("accepts a normal two-way quote", () => {
  assert.equal(isValidH2HQuote(-150, 130), true);
});

test("rejects a missing side", () => {
  assert.equal(isValidH2HQuote(-150, null), false);
  assert.equal(isValidH2HQuote(undefined, 130), false);
});

test("rejects an absurdly long price (> 2500)", () => {
  assert.equal(isValidH2HQuote(-150, 3300), false);
});

test("rejects a lone sub-100 price (not a coin-flip pair)", () => {
  assert.equal(isValidH2HQuote(-50, 120), false);
});

test("rejects a structurally broken vig (> 15%)", () => {
  // -150 / -150 → implied ~1.20 total, a 20% hold.
  assert.equal(isValidH2HQuote(-150, -150), false);
});

// ---- consensusSnhl quorum ----

test("three valid books meet quorum", () => {
  const c = consensusSnhl(
    [book("draftkings", -150, 130), book("fanduel", -145, 125), book("betmgm", -155, 135)],
    "HOME",
    "AWAY",
  );
  assert.ok(c, "expected consensus");
  assert.equal(c!.booksCounted, 3);
  assert.equal(c!.quorumMet, true);
});

test("two valid books do NOT meet quorum", () => {
  const c = consensusSnhl([book("draftkings", -150, 130), book("fanduel", -145, 125)], "HOME", "AWAY");
  assert.ok(c, "expected consensus");
  assert.equal(c!.booksCounted, 2);
  assert.equal(c!.quorumMet, false);
});

test("PROPS_ONLY_BOOKS (prizepicks) are excluded from the count", () => {
  const c = consensusSnhl(
    [book("draftkings", -150, 130), book("fanduel", -145, 125), book("prizepicks", -150, 130)],
    "HOME",
    "AWAY",
  );
  assert.ok(c, "expected consensus");
  assert.equal(c!.booksCounted, 2); // prizepicks dropped
  assert.equal(c!.quorumMet, false);
});

test("a book with structurally broken vig is dropped", () => {
  // -400 / -400 → ~1.60 implied total, far outside [0.95, 1.25].
  const c = consensusSnhl(
    [book("draftkings", -150, 130), book("fanduel", -145, 125), book("betrivers", -400, -400)],
    "HOME",
    "AWAY",
  );
  assert.ok(c, "expected consensus");
  assert.equal(c!.booksCounted, 2); // broken book dropped → below quorum
  assert.equal(c!.quorumMet, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
