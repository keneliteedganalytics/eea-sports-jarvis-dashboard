// Pillar 2 (v6.9.0) — injury/lineup ingest. Proves the pure core: the top-6 bats
// by season wOBA are the "key" bats, an IL bat counts as out, a DTD bat absent
// from a POSTED order counts as out (but is ignored when no order is posted yet),
// the wOBA penalty is 0.020/bat capped at 0.060, and the 2+-bats-out SNIPER
// demotion rule fires. Spec scenario: a club missing its two best bats (Judge +
// Soto analog) loses 0.040 wOBA and a SNIPER backing it demotes. Pure — no
// network. Run: tsx server/__tests__/injuries.test.ts

import assert from "node:assert/strict";
import {
  assessKeyBatsOut,
  wobaPenaltyFor,
  injuryForcesSniperDemotion,
  MAX_WOBA_PENALTY,
  type RosterBat,
} from "../sources/injuries";

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

console.log("Pillar 2 — injury/lineup ingest (v6.9.0)");

const bats: RosterBat[] = [
  { playerId: 1, name: "Judge", seasonWoba: 0.44 },
  { playerId: 2, name: "Soto", seasonWoba: 0.42 },
  { playerId: 3, name: "Stanton", seasonWoba: 0.36 },
  { playerId: 4, name: "Rizzo", seasonWoba: 0.33 },
  { playerId: 5, name: "Torres", seasonWoba: 0.32 },
  { playerId: 6, name: "Volpe", seasonWoba: 0.31 },
  { playerId: 7, name: "Bench A", seasonWoba: 0.28 },
  { playerId: 8, name: "Bench B", seasonWoba: 0.27 },
];

test("wobaPenaltyFor: 2 bats out → 0.040", () => {
  assert.ok(Math.abs(wobaPenaltyFor(2) - 0.04) < 1e-9, `got ${wobaPenaltyFor(2)}`);
});

test("wobaPenaltyFor caps at 0.060 (4 bats → 0.060 not 0.080)", () => {
  assert.equal(wobaPenaltyFor(4), MAX_WOBA_PENALTY);
});

test("Judge+Soto on the IL → 2 key bats out, 0.040 penalty", () => {
  const il = new Set([1, 2]);
  const a = assessKeyBatsOut(bats, il, [3, 4, 5, 6, 7, 8, 9]);
  assert.equal(a.keyBatsOut.length, 2);
  assert.ok(Math.abs(a.wobaPenalty - 0.04) < 1e-9, `got ${a.wobaPenalty}`);
  assert.deepEqual(a.keyBatsOut.map((b) => b.name).sort(), ["Judge", "Soto"]);
});

test("a SNIPER backing a team missing 2 key bats demotes", () => {
  const il = new Set([1, 2]);
  const a = assessKeyBatsOut(bats, il, [3, 4, 5, 6, 7, 8, 9]);
  assert.equal(injuryForcesSniperDemotion(a.keyBatsOut.length), true);
});

test("DTD bat absent from a POSTED order counts as out", () => {
  // No IL; Stanton (id 3, a key bat) not in the posted order → DTD_not_in_lineup.
  const a = assessKeyBatsOut(bats, new Set(), [1, 2, 4, 5, 6, 7, 8]);
  const stanton = a.keyBatsOut.find((b) => b.name === "Stanton");
  assert.ok(stanton, "Stanton should be flagged out");
  assert.equal(stanton?.reason, "DTD_not_in_lineup");
});

test("no posted order yet → DTD bats are NOT flagged (pending, no fabrication)", () => {
  const a = assessKeyBatsOut(bats, new Set(), []); // no lineup posted
  assert.equal(a.keyBatsOut.length, 0);
  assert.equal(a.wobaPenalty, 0);
});

test("only top-6 by wOBA are 'key' — a missing 7th bat is ignored", () => {
  const il = new Set([7]); // Bench A is 7th by wOBA, not a key bat
  const a = assessKeyBatsOut(bats, il, [1, 2, 3, 4, 5, 6, 8]);
  assert.equal(a.keyBatsOut.length, 0);
});

test("one bat out does NOT trigger the demotion (needs 2+)", () => {
  assert.equal(injuryForcesSniperDemotion(1), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
