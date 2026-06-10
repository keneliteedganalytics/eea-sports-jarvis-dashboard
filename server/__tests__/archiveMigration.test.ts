// Regression for the v6.5.1 outage: booting against a pre-v6.5 graded_book.db
// (pick_history with no archive columns) must run the archive migration in place
// — not abort. The original bug created idx_pick_history_archived_at in the same
// upfront exec() batch as the CREATE TABLEs, so on an existing DB (where the
// CREATE TABLE is a no-op and archived_at doesn't exist yet) SQLite threw
// "no such column: archived_at" and every pick_history read 500'd.
// Run: tsx server/__tests__/archiveMigration.test.ts

import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graded-archive-mig-"));
const dbFile = path.join(tmpDir, "graded_book.db");
process.env.GRADED_BOOK_PATH = dbFile;
process.env.BANKROLL_USD = "25000";

// Build a v6.4-era DB on disk BEFORE importing gradedBook: pick_history without
// the v6.5 archive columns, a live graded loss in picks (the score source for the
// backfill), and a bankroll_state row that must survive the migration untouched.
const seed = new Database(dbFile);
seed.pragma("journal_mode = WAL");
seed.exec(`
  CREATE TABLE pick_history (
    pick_id TEXT PRIMARY KEY, sport TEXT, graded_at TEXT, pick_label TEXT, tier TEXT,
    result TEXT, stake_units REAL, stake_dollars REAL, pl_units REAL, pl_dollars REAL,
    posted_odds INTEGER, closing_odds INTEGER, clv_pct REAL
  );
  CREATE TABLE picks (
    id TEXT PRIMARY KEY, gameId TEXT, sport TEXT, gameDate TEXT, gameTimeEt TEXT, matchup TEXT,
    homeTeam TEXT, awayTeam TEXT, homeTeamFull TEXT, awayTeamFull TEXT,
    pickSide TEXT, pickTeam TEXT, pickTeamFull TEXT, pickType TEXT, pickLine REAL, pickMl INTEGER, pickBook TEXT,
    status TEXT, finalAwayScore INTEGER, finalHomeScore INTEGER, result TEXT, pl REAL, gradedAt TEXT,
    units REAL, stakeDollars REAL, createdAt TEXT, updatedAt TEXT, locked INTEGER DEFAULT 0
  );
  CREATE TABLE bankroll_state (
    id INTEGER PRIMARY KEY DEFAULT 1, starting_bankroll REAL, current_bankroll REAL,
    lifetime_wins INTEGER DEFAULT 0, lifetime_losses INTEGER DEFAULT 0, lifetime_pushes INTEGER DEFAULT 0,
    lifetime_net_units REAL DEFAULT 0, lifetime_net_dollars REAL DEFAULT 0, last_updated TEXT
  );
  INSERT INTO bankroll_state (id, starting_bankroll, current_bankroll, lifetime_losses, lifetime_net_dollars, last_updated)
    VALUES (1, 25000, 24700, 3, -300, '2026-06-09T00:00:00Z');
  INSERT INTO pick_history (pick_id, sport, graded_at, pick_label, tier, result, stake_units, stake_dollars, pl_units, pl_dollars)
    VALUES ('g1:ML:home', 'mlb', '2026-06-01T23:30:00Z', 'HOM ML -110', 'EDGE', 'L', 1, 100, -1, -100);
  INSERT INTO picks (id, gameId, sport, status, finalAwayScore, finalHomeScore, homeTeam, awayTeam, result, gradedAt)
    VALUES ('g1:ML:home', 'g1', 'mlb', 'final', 4, 2, 'HOM', 'AWY', 'L', '2026-06-01T23:30:00Z');
`);
seed.close();

// First touch boots gradedDb() and runs the migration pipeline against the
// pre-existing DB. If the regression returns, this import-driven boot throws.
const { gradedDb, pickHistory, archivedPicks, pickHistoryCount, getBankrollState } =
  await import("../gradedBook");

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

console.log("archiveMigration");

test("boot against a pre-v6.5 DB adds the archive columns (no abort)", () => {
  const cols = new Set(
    (gradedDb().prepare("PRAGMA table_info(pick_history)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    ),
  );
  for (const c of ["archived_at", "final_away_score", "final_home_score", "home_team", "away_team"]) {
    assert.ok(cols.has(c), `expected pick_history.${c} to exist after migration`);
  }
});

test("a SELECT referencing archived_at succeeds (the failing prod query)", () => {
  // This is exactly what the prod endpoints did and what threw 500 before the fix.
  const rows = gradedDb()
    .prepare("SELECT pick_id, archived_at FROM pick_history WHERE archived_at IS NOT NULL")
    .all();
  assert.ok(Array.isArray(rows));
});

test("the archive index is built on archived_at", () => {
  const idx = gradedDb()
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_pick_history_archived_at'")
    .get() as { name: string } | undefined;
  assert.equal(idx?.name, "idx_pick_history_archived_at");
});

test("pickHistory() and archivedPicks() return the existing row", () => {
  assert.equal(pickHistoryCount(), 1);
  const rows = pickHistory();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pick_id, "g1:ML:home");
  const page = archivedPicks();
  assert.equal(page.total, 1);
  assert.equal(page.items[0].pick_id, "g1:ML:home");
});

test("backfill sets archived_at (graded_at + 6h for the pre-existing row)", () => {
  const row = gradedDb()
    .prepare("SELECT archived_at FROM pick_history WHERE pick_id = 'g1:ML:home'")
    .get() as { archived_at: string | null };
  assert.ok(row.archived_at, "archived_at must be backfilled");
  // 2026-06-01T23:30:00Z + 6h = 2026-06-02T05:30:00Z
  assert.equal(new Date(row.archived_at!).toISOString(), "2026-06-02T05:30:00.000Z");
});

test("backfill joins final score + teams from the live picks row", () => {
  const item = archivedPicks().items[0];
  assert.equal(item.final_score, "AWY 4 — HOM 2");
});

test("bankroll_state row is preserved (3 losses, -$300) — never reseeded", () => {
  const bk = getBankrollState();
  assert.equal(bk.starting, 25000);
  assert.equal(bk.current, 24700);
  assert.equal(bk.record.losses, 3);
  assert.equal(bk.netDollars, -300);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
