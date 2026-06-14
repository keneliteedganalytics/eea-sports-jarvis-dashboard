// v6.9.0 — deliberate engine bankroll/stats reset. Proves: an untagged history
// is re-bucketed to "legacy", the running bankroll + lifetime ledger reset to the
// target, the event is recorded in engine_resets, a second call with the same
// resetKey is a no-op (idempotent), and the analytics engine-version filter then
// isolates the post-reset (current) record from the legacy bucket.
// Runs against a throwaway graded book. Run: tsx server/__tests__/engineReset.test.ts

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graded-reset-"));
process.env.GRADED_BOOK_PATH = path.join(tmpDir, "test_book.db");
process.env.BANKROLL_USD = "25000";

const {
  gradedDb,
  getBankrollState,
  applyGradeToBankroll,
  resetEngineBankroll,
  availableEngineVersions,
  gradedPropPicks,
} = await import("../gradedBook");

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

console.log("v6.9.0 — engine reset");

// Seed: move the bankroll off the starting value, and write graded history rows
// (one game-line, two prop) so we can watch them re-bucket.
const db = gradedDb();
applyGradeToBankroll(db, { result: "L", stakeDollars: 1377, plUnits: -1, americanOdds: -110 });
db.prepare(
  `INSERT INTO pick_history (pick_id, sport, graded_at, pick_label, tier, result, stake_units, pl_units)
   VALUES ('g1','mlb','2026-06-10T00:00:00Z','NYY ML','SNIPER','L',1,-1)`,
).run();
db.prepare(
  `INSERT INTO prop_picks (pick_id, sport, game_id, player_name, market_type, line, side, tier, result, graded_at, stake_units, pl_units)
   VALUES ('p1','mlb','gx','Aaron Judge','HR',0.5,'over','SNIPER','W','2026-06-10T00:00:00Z',1,2)`,
).run();
db.prepare(
  `INSERT INTO prop_picks (pick_id, sport, game_id, player_name, market_type, line, side, tier, result, graded_at, stake_units, pl_units)
   VALUES ('p2','mlb','gy','Juan Soto','TB',1.5,'under','EDGE','L','2026-06-10T00:00:00Z',1,-1)`,
).run();

await test("pre-reset bankroll is off the starting value", () => {
  const s = getBankrollState();
  assert.ok(s.current < 25000, `expected a drawn-down bankroll, got ${s.current}`);
  assert.equal(s.record.losses, 1);
});

await test("reset re-buckets untagged history to legacy and resets bankroll", () => {
  const r = resetEngineBankroll({ resetKey: "engine_reset_v6_9_0", toEngineVersion: "v6.9.0" });
  assert.equal(r.alreadyApplied, false);
  assert.equal(r.legacyBucket, "legacy");
  assert.equal(r.newBankroll, 25000);
  assert.equal(r.rowsRebucketed, 1, "one game-line row re-bucketed");
  assert.equal(r.propRowsRebucketed, 2, "two prop rows re-bucketed");

  const s = getBankrollState();
  assert.equal(s.current, 25000);
  assert.equal(s.starting, 25000);
  assert.equal(s.record.wins, 0);
  assert.equal(s.record.losses, 0);
  assert.equal(s.netDollars, 0);
});

await test("event is recorded in engine_resets with prev/new values", () => {
  const row = db
    .prepare("SELECT * FROM engine_resets WHERE reset_key = 'engine_reset_v6_9_0' ORDER BY id DESC LIMIT 1")
    .get() as { prev_bankroll: number; new_bankroll: number; rows_rebucketed: number } | undefined;
  assert.ok(row, "expected an engine_resets row");
  assert.ok(row!.prev_bankroll < 25000, `prev should be the drawn-down value, got ${row!.prev_bankroll}`);
  assert.equal(row!.new_bankroll, 25000);
  assert.equal(row!.rows_rebucketed, 1);
});

await test("second call with the same resetKey is an idempotent no-op", () => {
  // Move the bankroll again, then re-run: it must NOT reset a second time.
  applyGradeToBankroll(db, { result: "W", stakeDollars: 1000, plUnits: 1, americanOdds: 100 });
  const before = getBankrollState().current;
  const r = resetEngineBankroll({ resetKey: "engine_reset_v6_9_0", toEngineVersion: "v6.9.0" });
  assert.equal(r.alreadyApplied, true);
  assert.equal(r.rowsRebucketed, 0);
  assert.equal(getBankrollState().current, before, "bankroll must be untouched on a repeat reset");
});

await test("availableEngineVersions surfaces the legacy bucket", () => {
  const vs = availableEngineVersions();
  assert.ok(vs.includes("ALL"));
  assert.ok(vs.includes("current"));
  assert.ok(vs.includes("legacy"), `expected legacy in ${JSON.stringify(vs)}`);
});

await test("engine-version filter isolates legacy from current prop rows", () => {
  const legacy = gradedPropPicks({ engineVersion: "legacy" });
  assert.equal(legacy.length, 2, "both seeded props are now legacy");
  const current = gradedPropPicks({ engineVersion: "current" });
  assert.equal(current.length, 0, "no current-engine props graded yet");
  const all = gradedPropPicks({ engineVersion: "ALL" });
  assert.equal(all.length, 2);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
