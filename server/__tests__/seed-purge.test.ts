// Guards the "no fabricated data" mandate: with an empty graded book, the track
// record returns zero KPIs + an empty log, and hit-rate tiers are empty. Also
// asserts no seed/sample data lingers in the track-record source.
// Run: tsx server/__tests__/seed-purge.test.ts

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Fresh empty book.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graded-purge-"));
process.env.GRADED_BOOK_PATH = path.join(tmpDir, "empty_book.db");

const { trackRecord, hitRatesByTier } = await import("../sports/mlb/trackRecord");

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

console.log("seed purge — empty graded book");

test("trackRecord on empty book: zero KPIs, empty log", () => {
  const tr = trackRecord("MLB");
  assert.equal(tr.totalBets, 0);
  assert.equal(tr.betLog.length, 0);
  assert.equal(tr.record.wins, 0);
  assert.equal(tr.record.losses, 0);
  assert.equal(tr.record.pushes, 0);
  assert.equal(tr.evRealizedUnits, 0);
  assert.equal(tr.roiPct, 0);
  assert.equal(tr.clvPct, 0);
});

test("trackRecord ALL sports on empty book is also empty", () => {
  assert.equal(trackRecord("ALL").totalBets, 0);
});

test("hitRatesByTier on empty book is empty", () => {
  assert.equal(hitRatesByTier("MLB").length, 0);
});

test("no fabricated seed strings remain in track-record source", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "server", "sports", "mlb", "trackRecord.ts"), "utf8");
  for (const needle of ["LAD @ SF", "NYY @ BOS", "SAMPLE_LOG", "144-123", "+29.5", "2.3;", "6.4;"]) {
    assert.ok(!src.includes(needle), `seed artifact "${needle}" still present`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
