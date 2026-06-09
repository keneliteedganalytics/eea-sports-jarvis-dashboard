// One-shot backfill: find the most recent Pittsburgh Pirates moneyline pick in
// the graded book and lock it in (freeze tier/stake/odds) so a downstream slate
// recompute can't re-tier it to PASS again.
//
// The original published tier was never written to an audit/history table, so
// the best recovery is the tier currently stored on the row. If the row has
// ALREADY been clobbered to PASS, this script will refuse to lock a PASS and
// instead print a clear warning — the user must supply the original tier with
// the TIER env var (e.g. TIER=SNIPER tsx server/scripts/backfillPiratesLock.ts).
//   Run: tsx server/scripts/backfillPiratesLock.ts

import { gradedDb, confirmBet, type GradedPick } from "../gradedBook";

function findPiratesMl(): GradedPick | undefined {
  const db = gradedDb();
  // PIT abbreviation + ML market. Newest by gameDate.
  return db
    .prepare(
      `SELECT * FROM picks
       WHERE pickType = 'ML' AND (pickTeam = 'PIT' OR pickTeamFull LIKE '%Pirates%')
       ORDER BY gameDate DESC, gameTimeEt DESC LIMIT 1`,
    )
    .get() as GradedPick | undefined;
}

function main(): void {
  const row = findPiratesMl();
  if (!row) {
    console.warn(
      "Pirates backfill incomplete — no Pittsburgh Pirates ML pick found in the graded book. User to confirm.",
    );
    process.exit(0);
  }

  const overrideTier = process.env.TIER?.trim().toUpperCase();
  if (row.locked) {
    console.log(`Pirates pick ${row.id} already locked at ${row.lockedTier}. Nothing to do.`);
    return;
  }

  if (row.tier === "PASS" && !overrideTier) {
    console.warn(
      `Pirates backfill incomplete — pick ${row.id} is currently stored as PASS and the original ` +
        `tier is not recoverable from history. Re-run with TIER=<ORIGINAL_TIER> to lock it. User to confirm.`,
    );
    process.exit(0);
  }

  if (overrideTier && overrideTier !== row.tier) {
    const db = gradedDb();
    db.prepare("UPDATE picks SET tier=@tier, updatedAt=@now WHERE id=@id").run({
      tier: overrideTier,
      now: new Date().toISOString(),
      id: row.id,
    });
    console.log(`Set ${row.id} tier → ${overrideTier} (from ${row.tier}) before locking.`);
  }

  const frozen = confirmBet(row.id);
  console.log(
    `Locked Pirates pick ${frozen?.id}: tier=${frozen?.lockedTier} stake=${frozen?.lockedStake} odds=${frozen?.lockedOdds}`,
  );
}

main();
