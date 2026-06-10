// v6.7.7: the PASS backfill is a one-shot boot job. Proves it is idempotent —
// the rebuild runs exactly once, and a second invocation (e.g. a redeploy)
// short-circuits on the system_state flag without re-running the build.
// Run: tsx server/__tests__/recordPassesV677.test.ts

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graded-recordpass-"));
process.env.GRADED_BOOK_PATH = path.join(tmpDir, "test_book.db");
process.env.BANKROLL_USD = "25000";

const { gradedDb, getSystemState, setSystemState } = await import("../gradedBook");
const { recordPassesV677, recordPassesFlag, RECORD_PASSES_FLAG } = await import("../jobs/recordPassesV677");
import type { BuildSummary } from "../sports/props/buildPropPicks";

gradedDb();
const DATE = "2026-06-10";

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
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

console.log("record passes v677 (v6.7.7)");

let buildCalls = 0;
const fakeBuild = async (date: string): Promise<BuildSummary> => {
  buildCalls++;
  return { date, considered: 70, written: 7, passed: 63, pickIds: ["x"] };
};
const deps = { build: fakeBuild as never, getState: getSystemState, setState: setSystemState };

await test("first run executes the rebuild and reports the PASS count", async () => {
  const r = await recordPassesV677(DATE, deps);
  assert.equal(r.alreadyCompleted, false, "first run is not a no-op");
  assert.equal(r.written, 7);
  assert.equal(r.passed, 63);
  assert.equal(buildCalls, 1, "build invoked exactly once");
});

await test("the completion flag is set after the first run", () => {
  assert.equal(getSystemState(RECORD_PASSES_FLAG), "true");
  assert.equal(recordPassesFlag().ran, true);
});

await test("second run short-circuits — build is NOT invoked again", async () => {
  const r = await recordPassesV677(DATE, deps);
  assert.equal(r.alreadyCompleted, true, "second run is a no-op");
  assert.equal(r.written, 0);
  assert.equal(r.passed, 0);
  assert.equal(buildCalls, 1, "build still called only once — idempotent");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
