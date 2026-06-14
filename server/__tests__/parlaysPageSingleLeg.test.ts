// Parlays page single-leg UI contract (v6.8.0). The page now renders each row as
// an individual $100 paper bet — NOT a multi-leg parlay. There is no component
// test harness here (tests are standalone tsx), so this pins the v6.8.0 contract
// against the page source: the "X-LEG" badge is gone, the card title is built
// from the single leg (legs[0]), and the legs-progress <ul> is removed. A
// regression back to the v6.7.9 grouped layout is caught.
// Run: tsx server/__tests__/parlaysPageSingleLeg.test.ts

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pageSrc = fs.readFileSync(
  path.resolve(here, "../../client/src/pages/Parlays.tsx"),
  "utf8",
);

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

console.log("Parlays page single-leg contract — v6.8.0");

test("no 'X-LEG' / leg-count badge remains in the card", () => {
  assert.ok(!/-LEG/i.test(pageSrc), "found a literal -LEG badge");
  assert.ok(!/legCount/.test(pageSrc), "card still references legCount");
});

test("card title is built from the single leg (legs[0])", () => {
  assert.ok(/parlay\.legs\[0\]/.test(pageSrc), "card no longer reads legs[0]");
  assert.ok(/leg\.player/.test(pageSrc), "card title does not use the leg player");
});

test("the multi-leg progress list (legsWon/legsPending) is gone", () => {
  assert.ok(!/legsWon/.test(pageSrc), "found a legsWon progress reference");
  assert.ok(!/legsPending/.test(pageSrc), "found a legsPending progress reference");
});

test("page copy reflects per-pick paper bets", () => {
  assert.ok(/Virtual Bets/.test(pageSrc), "title is not 'Virtual Bets'");
  assert.ok(/\$100 paper bet/.test(pageSrc), "subtitle missing the $100 paper-bet framing");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
