// pick_history: permanent ledger writes on grade, idempotency, and the boot
// backfill from pre-existing final picks. Run: tsx server/__tests__/pickHistory.test.ts

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graded-history-"));
const dbFile = path.join(tmpDir, "test_book.db");
process.env.GRADED_BOOK_PATH = dbFile;
process.env.BANKROLL_USD = "25000";

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

console.log("pick_history");

// Pre-seed a final pick row + the schema directly so the module's boot backfill
// has something to migrate when gradedDb() first opens the file.
function preSeedFinalPick(): void {
  const db = new Database(dbFile);
  db.exec(`
    CREATE TABLE IF NOT EXISTS picks (
      id TEXT PRIMARY KEY, gameId TEXT, sport TEXT, gameDate TEXT, gameTimeEt TEXT,
      matchup TEXT, homeTeam TEXT, awayTeam TEXT, homeTeamFull TEXT, awayTeamFull TEXT,
      pickSide TEXT, pickTeam TEXT, pickTeamFull TEXT, pickType TEXT, pickLine REAL,
      pickMl INTEGER, pickBook TEXT, gameStartIso TEXT, postedOddsAmerican INTEGER,
      postedAt TEXT, closingOddsAmerican INTEGER, closingCapturedAt TEXT, closingSource TEXT,
      clvPoints REAL, clvPercent REAL, lockStatus TEXT, tier TEXT, units REAL, stakeDollars REAL,
      pickWinProb REAL, pickImpliedProb REAL, edgePp REAL, evPer100 REAL, confidence INTEGER,
      fairMl INTEGER, status TEXT, liveAwayScore INTEGER, liveHomeScore INTEGER, liveStatusDetail TEXT,
      finalAwayScore INTEGER, finalHomeScore INTEGER, result TEXT, pl REAL, clvPct REAL,
      gradedAt TEXT, createdAt TEXT, updatedAt TEXT, locked INTEGER DEFAULT 0,
      lockedAt TEXT, lockedTier TEXT, lockedStake REAL, lockedOdds INTEGER
    );
  `);
  db.prepare(
    `INSERT INTO picks (id, gameId, sport, gameDate, gameTimeEt, matchup, homeTeam, awayTeam,
      homeTeamFull, awayTeamFull, pickSide, pickTeam, pickTeamFull, pickType, pickMl, tier,
      units, stakeDollars, status, result, pl, clvPct, gradedAt, createdAt, updatedAt, locked)
     VALUES ('seedGame:ML:away','seedGame','mlb','2026-06-01','7:05 PM ET','AAA @ BBB','BBB','AAA',
      'B','A','away','AAA','A','ML',120,'SNIPER',2,800,'final','W',2.4,3.1,'2026-06-01T23:30:00Z',
      '2026-06-01T18:00:00Z','2026-06-01T23:30:00Z',0)`,
  ).run();
  db.close();
}

preSeedFinalPick();

const { gradedDb, pickHistory, pickHistoryCount, upsertPick, pickId, settlePick, recordGradeLedger } =
  await import("../gradedBook");

await test("boot backfill: pre-existing final pick lands in pick_history", () => {
  gradedDb(); // triggers backfill
  const rows = pickHistory();
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.pick_id, "seedGame:ML:away");
  assert.equal(r.result, "W");
  assert.equal(r.tier, "SNIPER");
  assert.equal(r.pl_units, 2.4);
  // pl_dollars = pl_units × (stakeDollars/units) = 2.4 × 400 = 960
  assert.equal(r.pl_dollars, 960);
  assert.equal(r.clv_pct, 3.1);
});

await test("grading a new pick appends one row to pick_history", () => {
  const id = pickId("hx1", "ML", "home");
  upsertPick({
    gameId: "hx1", sport: "nba", gameDate: "2026-06-08", gameTimeEt: "8:00 PM ET",
    matchup: "LAL @ BOS", homeTeam: "BOS", awayTeam: "LAL",
    homeTeamFull: "Boston", awayTeamFull: "LA Lakers",
    pickSide: "home", pickTeam: "BOS", pickTeamFull: "Boston", pickType: "ML",
    pickLine: null, pickMl: -110, pickBook: "FD", gameStartIso: "2026-06-09T00:00:00Z",
    tier: "EDGE", units: 1, stakeDollars: 300,
    pickWinProb: 0.55, pickImpliedProb: 0.52, edgePp: 3, evPer100: 4, confidence: 62, fairMl: -120,
  });
  settlePick(id, { finalAwayScore: 100, finalHomeScore: 110, result: "W", pl: 0.91, clvPct: 1.2, liveStatusDetail: "Final" });
  const before = pickHistoryCount();
  recordGradeLedger(id);
  assert.equal(pickHistoryCount(), before + 1);
  const row = pickHistory("nba").find((r) => r.pick_id === id);
  assert.ok(row);
  assert.equal(row!.result, "W");
  assert.equal(row!.sport, "nba");
});

await test("idempotent on pick_id — a second recordGradeLedger adds no rows", () => {
  const id = pickId("hx1", "ML", "home");
  const before = pickHistoryCount();
  recordGradeLedger(id);
  recordGradeLedger(id);
  assert.equal(pickHistoryCount(), before);
});

await test("sport filter narrows the ledger", () => {
  const all = pickHistory();
  const nba = pickHistory("nba");
  const mlb = pickHistory("mlb");
  assert.ok(all.length >= nba.length + mlb.length);
  assert.ok(nba.every((r) => r.sport === "nba"));
});

await test("history row captures posted odds + a readable label", () => {
  const id = pickId("hx1", "ML", "home");
  const row = pickHistory("nba").find((r) => r.pick_id === id)!;
  assert.ok(row.pick_label.startsWith("BOS ML"), `label was: ${row.pick_label}`);
  assert.equal(row.posted_odds, -110); // forceInsert stamps postedOddsAmerican = pickMl
  assert.equal(row.stake_dollars, 300);
  assert.equal(row.stake_units, 1);
});

await test("positive-odds label is signed with a leading +", () => {
  const row = pickHistory().find((r) => r.pick_id === "seedGame:ML:away")!;
  assert.ok(row.pick_label.includes("+120"), `label was: ${row.pick_label}`);
});

await test("a non-final pick is not recorded by recordGradeLedger", () => {
  const id = pickId("pendingHx", "ML", "home");
  upsertPick({
    gameId: "pendingHx", sport: "mlb", gameDate: "2026-06-10", gameTimeEt: "7:05 PM ET",
    matchup: "CCC @ DDD", homeTeam: "DDD", awayTeam: "CCC",
    homeTeamFull: "D", awayTeamFull: "C",
    pickSide: "home", pickTeam: "DDD", pickTeamFull: "D", pickType: "ML",
    pickLine: null, pickMl: 110, pickBook: "DK", gameStartIso: "2026-06-10T23:05:00Z",
    tier: "RECON", units: 1, stakeDollars: 200,
    pickWinProb: 0.5, pickImpliedProb: 0.5, edgePp: 0, evPer100: 0, confidence: 55, fairMl: 110,
  });
  const before = pickHistoryCount();
  recordGradeLedger(id); // still pending → no-op
  assert.equal(pickHistoryCount(), before);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
