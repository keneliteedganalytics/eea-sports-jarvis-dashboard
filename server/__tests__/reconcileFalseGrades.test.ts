// v6.7.5 false-grade reconciliation. The v6.7.3 live tracker graded prop picks
// against games that had not started, crediting phantom wins to the bankroll.
// These tests pin the unwind math (bankroll reversal, grade clear, history
// delete, audit row) and the one-shot reconciliation's behaviour: it unwinds a
// graded pick whose game is positively NOT final, leaves a legitimately-final
// grade alone, never touches a pick whose game status can't be resolved, and
// runs exactly once (idempotency flag). Run: tsx server/__tests__/reconcileFalseGrades.test.ts

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graded-reconcile-v675-"));
process.env.GRADED_BOOK_PATH = path.join(tmpDir, "test_book.db");

const gb = await import("../gradedBook");
const { reconcileFalseGradesV675, RECONCILIATION_FLAG } = await import("../jobs/reconcileFalseGrades");
type ReconcileDeps = import("../jobs/reconcileFalseGrades").ReconcileDeps;

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return (async () => {
    try {
      await fn();
      passed++;
      console.log(`  ok   ${name}`);
    } catch (err) {
      failed++;
      console.error(`  FAIL ${name}`);
      console.error(`       ${(err as Error).message}`);
    }
  })();
}

// Seed a prop pick, then mark it graded W with a phantom +$367.50 credit and the
// matching bankroll delta — exactly the v6.7.3 corruption shape.
function seedFalseGrade(pickId: string, plDollars: number, plUnits: number, team?: string): void {
  gb.upsertPropPick({
    pick_id: pickId,
    sport: "mlb",
    game_id: `evt-${pickId}`,
    player_name: "Corey Seager",
    team: team ?? null,
    market_type: "batter_hits",
    line: 1.5,
    side: "under",
    posted_odds: 110,
    stake_units: 0.5,
  });
  const db = gb.gradedDb();
  db.prepare(
    `UPDATE prop_picks SET result='W', actual_value=0, pl_units=@pu, pl_dollars=@pd,
       graded_at=@now, live_state='paid', live_value=0, live_status='scheduled'
     WHERE pick_id=@id`,
  ).run({ id: pickId, pu: plUnits, pd: plDollars, now: new Date().toISOString() });
  // Mirror the bankroll credit the false grade applied.
  db.prepare(
    `UPDATE bankroll_state SET current_bankroll = current_bankroll + @pd,
       lifetime_wins = lifetime_wins + 1,
       lifetime_net_units = lifetime_net_units + @pu,
       lifetime_net_dollars = lifetime_net_dollars + @pd WHERE id = 1`,
  ).run({ pd: plDollars, pu: plUnits });
  // And a permanent pick_history entry that should never have existed.
  db.prepare(
    `INSERT INTO pick_history (pick_id, sport, result, pl_units, pl_dollars, graded_at)
     VALUES (@id, 'mlb', 'W', @pu, @pd, @now)`,
  ).run({ id: pickId, pu: plUnits, pd: plDollars, now: new Date().toISOString() });
}

console.log("v6.7.5 false-grade reconciliation");

await test("unwindFalsePropGrade reverses bankroll, clears grade, deletes history, writes audit", () => {
  const before = gb.getBankrollState().current;
  seedFalseGrade("seager-under", 367.5, 0.98);
  const afterCredit = gb.getBankrollState().current;
  assert.ok(Math.abs(afterCredit - (before + 367.5)) < 1e-6, "seed should credit +367.50");

  const result = gb.unwindFalsePropGrade("seager-under", "scheduled");
  assert.ok(result, "unwind should return a detail");
  assert.equal(result!.originalResult, "W");
  assert.equal(result!.originalPlDollars, 367.5);
  assert.equal(result!.gameStatusAtUnwind, "scheduled");

  // Bankroll restored to the pre-grade number.
  assert.ok(Math.abs(gb.getBankrollState().current - before) < 1e-6, "bankroll should be reverted");
  assert.equal(gb.getBankrollState().record.wins, 0, "win counter decremented");

  // Grade fields cleared, live snapshot reset.
  const pick = gb.getPropPick("seager-under")!;
  assert.equal(pick.result, null);
  assert.equal(pick.graded_at, null);
  assert.equal(pick.pl_dollars, null);
  assert.equal(pick.actual_value, null);
  assert.equal(pick.live_state, null);
  assert.equal(pick.live_status, null);

  // pick_history entry removed.
  const hist = gb.gradedDb().prepare("SELECT 1 FROM pick_history WHERE pick_id = ?").get("seager-under");
  assert.equal(hist, undefined, "pick_history row should be deleted");

  // Audit row written with the v6.7.5 reason.
  const audit = gb.gradedDb()
    .prepare("SELECT reason FROM pick_audit WHERE pickId = ? AND reason LIKE 'false_grade_unwound_v675%'")
    .get("seager-under") as { reason: string } | undefined;
  assert.ok(audit, "audit row should exist");
  assert.ok(audit!.reason.includes("result=W"), "audit reason carries original result");
  assert.ok(audit!.reason.includes("gameStatus=scheduled"), "audit reason carries game status");
});

await test("unwindFalsePropGrade is a no-op on an ungraded pick", () => {
  gb.upsertPropPick({
    pick_id: "ungraded",
    sport: "mlb",
    game_id: "evt-ungraded",
    player_name: "Mike Trout",
    market_type: "batter_hits",
    line: 0.5,
    side: "over",
    posted_odds: -110,
    stake_units: 0.5,
  });
  const result = gb.unwindFalsePropGrade("ungraded", "scheduled");
  assert.equal(result, null);
});

await test("reconcileFalseGradesV675 unwinds non-final, leaves final alone, skips unresolved", async () => {
  // Three fresh picks, each with a distinct team so resolveGamePk can map it.
  seedFalseGrade("rec-preview", 367.5, 0.98, "Texas Rangers");
  seedFalseGrade("rec-final", 200, 0.53, "Los Angeles Dodgers");
  seedFalseGrade("rec-unresolved", 100, 0.27, "Atlanta Braves");

  const before = gb.getBankrollState().current;

  // Schedule maps Rangers → pk-prev (Preview), Dodgers → pk-final (Final). The
  // Braves game is absent → resolveGamePk returns null → reconcile leaves it alone.
  const mkGame = (gamePk: string, home: string): import("../adapters/mlbStats").ScheduleGame => ({
    gamePk, startIso: "2026-06-10T23:00:00Z", homeTeamFull: home, awayTeamFull: "Opponent FC",
    homeTeam: home, awayTeam: "OPP", venue: "Park", homeTeamId: null, awayTeamId: null,
    homePitcherId: null, awayPitcherId: null, homePitcher: null, awayPitcher: null,
    homeBattingOrder: [], awayBattingOrder: [],
  } as never);
  const schedule = [mkGame("pk-prev", "Texas Rangers"), mkGame("pk-final", "Los Angeles Dodgers")];
  const feedByPk: Record<string, string> = { "pk-prev": "Preview", "pk-final": "Final" };

  const deps: ReconcileDeps = {
    candidates: () => ["rec-preview", "rec-final", "rec-unresolved"].map((id) => gb.getPropPick(id)!),
    schedule: async () => schedule,
    fetchLiveFeed: async (gamePk: string) => {
      const abstractGameState = feedByPk[gamePk];
      if (!abstractGameState) return null;
      return { gameData: { status: { abstractGameState } } } as never;
    },
    unwind: gb.unwindFalsePropGrade,
  };

  const summary = await reconcileFalseGradesV675("2026-06-10", deps);
  assert.equal(summary.alreadyCompleted, false);
  assert.equal(summary.unwound.length, 1, "only the Preview (non-final) pick unwinds");
  assert.equal(summary.unwound[0].pick_id, "rec-preview");
  assert.ok(Math.abs(summary.bankrollAdjustment - 367.5) < 1e-6, "adjustment equals the phantom credit");

  // rec-preview (Preview) unwound; rec-final (Final) and rec-unresolved (no game) untouched.
  assert.equal(gb.getPropPick("rec-preview")!.result, null);
  assert.equal(gb.getPropPick("rec-final")!.result, "W");
  assert.equal(gb.getPropPick("rec-unresolved")!.result, "W");
  // Bankroll dropped by exactly the one phantom credit.
  assert.ok(Math.abs(gb.getBankrollState().current - (before - 367.5)) < 1e-6);
  // Flag stamped.
  assert.equal(gb.getSystemState(RECONCILIATION_FLAG), "true");
});

await test("reconcileFalseGradesV675 is idempotent (second run is a no-op)", async () => {
  const deps: ReconcileDeps = {
    candidates: () => {
      throw new Error("candidates must not be queried once the flag is set");
    },
    schedule: async () => [],
    fetchLiveFeed: async () => null,
    unwind: gb.unwindFalsePropGrade,
  };
  const summary = await reconcileFalseGradesV675("2026-06-10", deps);
  assert.equal(summary.alreadyCompleted, true);
  assert.equal(summary.unwound.length, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
