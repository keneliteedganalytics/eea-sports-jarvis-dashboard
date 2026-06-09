// Home-plate umpire ingest (MLB). Verifies profile lookup (by id then name),
// the neutral fallback when no gamePk / no profile, and the short-name helper.
// Network paths are not exercised here — fetchHomePlateUmpire is best-effort and
// returns null on any failure, which umpireAdjustmentForGame folds into NEUTRAL.
// Run: tsx server/__tests__/umpire.test.ts

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point the loader at a temp stats file BEFORE importing the module.
const tmpStats = path.join(os.tmpdir(), `umpire_stats_${process.pid}.json`);
fs.writeFileSync(
  tmpStats,
  JSON.stringify([
    {
      umpireId: 427044,
      name: "Pat Hoberg",
      games: 142,
      avgRunsPerGame: 8.4,
      kPctDelta: 1.2,
      bbPctDelta: -0.6,
      runScoreAdjustment: -0.22,
    },
    {
      umpireId: 483910,
      name: "Ángel Hernández",
      games: 98,
      avgRunsPerGame: 9.7,
      kPctDelta: -1.8,
      bbPctDelta: 1.1,
      runScoreAdjustment: 0.34,
    },
  ]),
  "utf8",
);
process.env.UMPIRE_STATS_PATH = tmpStats;

const {
  profileFor,
  umpireShortName,
  umpireAdjustmentForGame,
  NEUTRAL_UMPIRE,
  _resetUmpireCache,
} = await import("../sports/mlb/umpires");

_resetUmpireCache();

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void | Promise<void>) {
  try {
    const r = fn();
    if (r instanceof Promise) {
      // tests here are sync except the explicit async ones below
    }
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err as Error).message}`);
  }
}
async function testAsync(name: string, fn: () => Promise<void>) {
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

console.log("umpire ingest — profile lookup + neutral fallback");

test("profileFor resolves by umpire id", () => {
  const p = profileFor(427044, null);
  assert.ok(p, "expected a profile by id");
  assert.equal(p!.name, "Pat Hoberg");
  assert.equal(p!.runScoreAdjustment, -0.22);
});

test("profileFor resolves by name (case/space-insensitive)", () => {
  const p = profileFor(null, "  pat   hoberg ");
  assert.ok(p, "expected a profile by name");
  assert.equal(p!.umpireId, 427044);
});

test("profileFor returns null for unknown umpire", () => {
  assert.equal(profileFor(999999, "Nobody Here"), null);
});

test("umpireShortName returns the surname", () => {
  assert.equal(umpireShortName("Pat Hoberg"), "Hoberg");
  assert.equal(umpireShortName("Ángel Hernández"), "Hernández");
  assert.equal(umpireShortName(null), "ump");
});

test("NEUTRAL_UMPIRE is a zeroed, not-found adjustment", () => {
  assert.equal(NEUTRAL_UMPIRE.found, false);
  assert.equal(NEUTRAL_UMPIRE.runScoreAdj, 0);
  assert.equal(NEUTRAL_UMPIRE.name, null);
});

await testAsync("umpireAdjustmentForGame(null) degrades to neutral", async () => {
  const adj = await umpireAdjustmentForGame(null);
  assert.equal(adj.found, false);
  assert.equal(adj.runScoreAdj, 0);
});

await testAsync("umpireAdjustmentForGame(undefined) degrades to neutral", async () => {
  const adj = await umpireAdjustmentForGame(undefined);
  assert.equal(adj.found, false);
});

// Cleanup
try {
  fs.unlinkSync(tmpStats);
} catch {
  /* ignore */
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
