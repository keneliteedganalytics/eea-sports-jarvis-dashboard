// Graded book — the desk's real, settled betting record. Every actionable pick
// the engine surfaces is persisted here; an ESPN-fed live-scoring job updates
// each row through pending → in_progress → final and grades it (W/L/P + P/L).
// There is NO seed data: an empty book renders empty KPIs and "No graded picks
// yet" until a real pick settles against a real final score.
//
// File path resolves via dbPath(): GRADED_BOOK_PATH override, else a mounted
// Railway persistent volume (RAILWAY_VOLUME_MOUNT_PATH) so live scores + CLV
// survive deploys, else the local data/graded_book.db fallback.

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type PickStatus = "pending" | "in_progress" | "final";
export type PickResult = "W" | "L" | "P";
// Closing Line Value lock lifecycle: 'open' until first pitch / tip / puck drop /
// kickoff, 'locked' once the closing line is captured + CLV computed, 'final'
// once the game completes.
export type LockStatus = "open" | "locked" | "final";

export interface GradedPick {
  id: string;
  gameId: string;
  sport: string;
  gameDate: string;
  gameTimeEt: string;
  matchup: string;
  homeTeam: string;
  awayTeam: string;
  homeTeamFull: string;
  awayTeamFull: string;
  pickSide: string;
  pickTeam: string;
  pickTeamFull: string;
  pickType: string;
  pickLine: number | null;
  pickMl: number | null;
  pickBook: string | null;
  // Actual game start (ISO) captured at pick generation — drives the lock window.
  gameStartIso: string | null;
  // Closing Line Value tracking. posted_* is the price at the moment the pick was
  // posted; closing_* is the snapshot taken when the lock window opens.
  postedOddsAmerican: number | null;
  postedAt: string | null;
  closingOddsAmerican: number | null;
  closingCapturedAt: string | null;
  closingSource: string | null;
  clvPoints: number | null;
  clvPercent: number | null;
  lockStatus: LockStatus;
  tier: string;
  units: number;
  stakeDollars: number;
  pickWinProb: number | null;
  pickImpliedProb: number | null;
  edgePp: number | null;
  evPer100: number | null;
  confidence: number | null;
  fairMl: number | null;
  status: PickStatus;
  liveAwayScore: number | null;
  liveHomeScore: number | null;
  liveStatusDetail: string | null;
  finalAwayScore: number | null;
  finalHomeScore: number | null;
  result: PickResult | null;
  pl: number | null;
  clvPct: number | null;
  gradedAt: string | null;
  createdAt: string;
  updatedAt: string;
  // Bet lock-in. Once the user confirms they placed a bet (Bet Placed button),
  // the pick is frozen: tier/stake/odds and pick-identifying fields can no
  // longer be re-tiered by a downstream slate recompute. The locked* columns
  // snapshot the values at confirmation time and are what analytics must show.
  locked: 0 | 1;
  lockedAt: string | null;
  lockedTier: string | null;
  lockedStake: number | null;
  lockedOdds: number | null;
}

// Resolve the SQLite file path. Precedence:
//   1. GRADED_BOOK_PATH        — explicit override (tests, manual ops).
//   2. RAILWAY_VOLUME_MOUNT_PATH — a mounted persistent volume; the book lives on
//      it so live scores + CLV state survive every deploy (container fs is wiped).
//   3. <cwd>/data/graded_book.db — local dev / CI fallback, unchanged from before.
export function dbPath(): string {
  if (process.env.GRADED_BOOK_PATH) return process.env.GRADED_BOOK_PATH;
  const volRoot = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  if (volRoot && volRoot.trim().length > 0) {
    return path.join(volRoot, "graded_book.db");
  }
  return path.join(process.cwd(), "data", "graded_book.db");
}

let _db: Database.Database | null = null;

export function gradedDb(): Database.Database {
  if (_db) return _db;
  const file = dbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  console.log(`[gradedBook] using SQLite at ${file}`);
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS picks (
      id TEXT PRIMARY KEY,
      gameId TEXT NOT NULL,
      sport TEXT NOT NULL,
      gameDate TEXT NOT NULL,
      gameTimeEt TEXT NOT NULL,
      matchup TEXT NOT NULL,
      homeTeam TEXT NOT NULL,
      awayTeam TEXT NOT NULL,
      homeTeamFull TEXT NOT NULL,
      awayTeamFull TEXT NOT NULL,
      pickSide TEXT NOT NULL,
      pickTeam TEXT NOT NULL,
      pickTeamFull TEXT NOT NULL,
      pickType TEXT NOT NULL,
      pickLine REAL,
      pickMl INTEGER,
      pickBook TEXT,
      gameStartIso TEXT,
      postedOddsAmerican INTEGER,
      postedAt TEXT,
      closingOddsAmerican INTEGER,
      closingCapturedAt TEXT,
      closingSource TEXT,
      clvPoints REAL,
      clvPercent REAL,
      lockStatus TEXT NOT NULL DEFAULT 'open',
      tier TEXT NOT NULL,
      units REAL NOT NULL,
      stakeDollars REAL NOT NULL,
      pickWinProb REAL,
      pickImpliedProb REAL,
      edgePp REAL,
      evPer100 REAL,
      confidence INTEGER,
      fairMl INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      liveAwayScore INTEGER,
      liveHomeScore INTEGER,
      liveStatusDetail TEXT,
      finalAwayScore INTEGER,
      finalHomeScore INTEGER,
      result TEXT,
      pl REAL,
      clvPct REAL,
      gradedAt TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      locked INTEGER NOT NULL DEFAULT 0,
      lockedAt TEXT,
      lockedTier TEXT,
      lockedStake REAL,
      lockedOdds INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_picks_gameDate ON picks(gameDate);
    CREATE INDEX IF NOT EXISTS idx_picks_status ON picks(status);
    CREATE INDEX IF NOT EXISTS idx_picks_sport ON picks(sport);
    CREATE TABLE IF NOT EXISTS pick_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pickId TEXT,
      action TEXT,
      fromTier TEXT,
      toTier TEXT,
      fromOdds REAL,
      toOdds REAL,
      reason TEXT,
      createdAt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pick_audit_pickId ON pick_audit(pickId);
    -- Single-row (id=1) running bankroll + lifetime W/L/P ledger. Adjusts every
    -- time a pick grades to final so the board's bankroll reflects real P/L,
    -- not the static BANKROLL_USD seed.
    CREATE TABLE IF NOT EXISTS bankroll_state (
      id INTEGER PRIMARY KEY DEFAULT 1,
      starting_bankroll REAL NOT NULL,
      current_bankroll REAL NOT NULL,
      lifetime_wins INTEGER NOT NULL DEFAULT 0,
      lifetime_losses INTEGER NOT NULL DEFAULT 0,
      lifetime_pushes INTEGER NOT NULL DEFAULT 0,
      lifetime_net_units REAL NOT NULL DEFAULT 0,
      lifetime_net_dollars REAL NOT NULL DEFAULT 0,
      last_updated TEXT
    );
    -- Permanent, append-only ledger: one row per graded pick, never deleted.
    -- Track Record + Analytics aggregate from here so lifetime stats survive
    -- even if the live picks table is wiped.
    CREATE TABLE IF NOT EXISTS pick_history (
      pick_id TEXT PRIMARY KEY,
      sport TEXT,
      graded_at TEXT,
      pick_label TEXT,
      tier TEXT,
      result TEXT,
      stake_units REAL,
      stake_dollars REAL,
      pl_units REAL,
      pl_dollars REAL,
      posted_odds INTEGER,
      closing_odds INTEGER,
      clv_pct REAL
    );
    CREATE INDEX IF NOT EXISTS idx_pick_history_sport ON pick_history(sport);
    CREATE INDEX IF NOT EXISTS idx_pick_history_graded_at ON pick_history(graded_at);
  `);
  // Migrate pre-lock databases in place (CREATE TABLE IF NOT EXISTS skips the new
  // columns on an existing table). Mirror of migrations/0001_pick_lock.sql.
  ensureColumns(sqlite, "picks", {
    locked: "INTEGER NOT NULL DEFAULT 0",
    lockedAt: "TEXT",
    lockedTier: "TEXT",
    lockedStake: "REAL",
    lockedOdds: "INTEGER",
    // CLV tracking — mirror of migrations/0003_clv.sql.
    gameStartIso: "TEXT",
    postedOddsAmerican: "INTEGER",
    postedAt: "TEXT",
    closingOddsAmerican: "INTEGER",
    closingCapturedAt: "TEXT",
    closingSource: "TEXT",
    clvPoints: "REAL",
    clvPercent: "REAL",
    lockStatus: "TEXT NOT NULL DEFAULT 'open'",
  });
  _db = sqlite;
  initBankrollState(sqlite);
  backfillPickHistory(sqlite);
  return _db;
}

// Default starting bankroll. Mirrors BANKROLL_USD in picksEngine but resolved
// here from env to keep gradedBook free of a static import on the slate engine
// (which imports gradedBook). Used only to seed bankroll_state on first boot.
const DEFAULT_BANKROLL_USD = 25000;
function startingBankrollFromEnv(): number {
  const n = Number(process.env.BANKROLL_USD);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BANKROLL_USD;
}

// Seed the single bankroll_state row (id=1) from BANKROLL_USD on first boot.
// Idempotent: a row already present is left untouched so accumulated P/L sticks.
function initBankrollState(db: Database.Database): void {
  const row = db.prepare("SELECT id FROM bankroll_state WHERE id = 1").get();
  if (row) return;
  const start = startingBankrollFromEnv();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO bankroll_state (id, starting_bankroll, current_bankroll, last_updated)
     VALUES (1, @start, @start, @now)`,
  ).run({ start, now });
}

// One-time migration: if pick_history is empty but the live picks table already
// carries graded (final) rows, backfill the permanent ledger from them so a book
// that graded picks before this layer existed doesn't lose its history.
function backfillPickHistory(db: Database.Database): void {
  const count = (db.prepare("SELECT COUNT(*) AS n FROM pick_history").get() as { n: number }).n;
  if (count > 0) return;
  const finals = db.prepare("SELECT * FROM picks WHERE status = 'final'").all() as GradedPick[];
  if (finals.length === 0) return;
  for (const r of finals) recordPickHistory(db, r);
}

export interface BankrollState {
  starting: number;
  current: number;
  netDollars: number;
  netUnits: number;
  record: { wins: number; losses: number; pushes: number };
  roiPct: number;
  lastUpdated: string | null;
}

interface BankrollRow {
  starting_bankroll: number;
  current_bankroll: number;
  lifetime_wins: number;
  lifetime_losses: number;
  lifetime_pushes: number;
  lifetime_net_units: number;
  lifetime_net_dollars: number;
  last_updated: string | null;
}

// Read the running bankroll + lifetime ledger. ROI is net dollars over the
// starting bankroll. Always returns a row (init seeds it on first boot).
export function getBankrollState(): BankrollState {
  const db = gradedDb();
  const row = db.prepare("SELECT * FROM bankroll_state WHERE id = 1").get() as BankrollRow | undefined;
  if (!row) {
    const start = startingBankrollFromEnv();
    return {
      starting: start,
      current: start,
      netDollars: 0,
      netUnits: 0,
      record: { wins: 0, losses: 0, pushes: 0 },
      roiPct: 0,
      lastUpdated: null,
    };
  }
  const roiPct =
    row.starting_bankroll > 0
      ? Math.round((row.lifetime_net_dollars / row.starting_bankroll) * 1000) / 10
      : 0;
  return {
    starting: row.starting_bankroll,
    current: row.current_bankroll,
    netDollars: Math.round(row.lifetime_net_dollars * 100) / 100,
    netUnits: Math.round(row.lifetime_net_units * 100) / 100,
    record: { wins: row.lifetime_wins, losses: row.lifetime_losses, pushes: row.lifetime_pushes },
    roiPct,
    lastUpdated: row.last_updated,
  };
}

// Apply one graded pick's result to the running bankroll + lifetime ledger.
//   W: current += stakeDollars × (decimalOdds − 1); +net dollars, +net units.
//   L: current −= stakeDollars; −net dollars, −net units.
//   P: pushes++, no bankroll change.
// Called from gradePick on the pending→final transition. Pure of the grade
// math itself — the caller passes the already-decided result + P/L in units.
export function applyGradeToBankroll(
  db: Database.Database,
  fields: { result: PickResult; stakeDollars: number; plUnits: number; americanOdds: number | null },
): void {
  const row = db.prepare("SELECT * FROM bankroll_state WHERE id = 1").get() as BankrollRow | undefined;
  if (!row) {
    initBankrollState(db);
  }
  const now = new Date().toISOString();
  const stake = fields.stakeDollars || 0;
  let deltaDollars = 0;
  let winInc = 0;
  let lossInc = 0;
  let pushInc = 0;
  if (fields.result === "W") {
    const dec = americanToDecimal(fields.americanOdds) ?? 2.0;
    deltaDollars = stake * (dec - 1);
    winInc = 1;
  } else if (fields.result === "L") {
    deltaDollars = -stake;
    lossInc = 1;
  } else {
    pushInc = 1;
  }
  db.prepare(
    `UPDATE bankroll_state SET
       current_bankroll = current_bankroll + @deltaDollars,
       lifetime_wins = lifetime_wins + @winInc,
       lifetime_losses = lifetime_losses + @lossInc,
       lifetime_pushes = lifetime_pushes + @pushInc,
       lifetime_net_units = lifetime_net_units + @plUnits,
       lifetime_net_dollars = lifetime_net_dollars + @deltaDollars,
       last_updated = @now
     WHERE id = 1`,
  ).run({ deltaDollars, winInc, lossInc, pushInc, plUnits: fields.plUnits, now });
}

// American → decimal price. Local copy (gradedBook stays free of a core/odds
// import) so the bankroll math doesn't pull in the engine graph.
function americanToDecimal(odds: number | null): number | null {
  if (odds === null || odds === undefined || odds === 0) return null;
  return 1.0 + (odds > 0 ? odds / 100.0 : 100.0 / -odds);
}

// Insert a graded pick into the permanent pick_history ledger. Idempotent on
// pick_id (a re-grade or backfill of the same id is ignored). Computes the
// dollar P/L from the stored units P/L scaled by stake-per-unit.
function recordPickHistory(db: Database.Database, r: GradedPick): void {
  const plUnits = r.pl ?? 0;
  const perUnit = r.units > 0 ? r.stakeDollars / r.units : 0;
  const plDollars = Math.round(plUnits * perUnit * 100) / 100;
  const label = `${r.pickTeam} ${r.pickType} ${
    r.pickMl !== null ? (r.pickMl > 0 ? `+${r.pickMl}` : r.pickMl) : ""
  }`.trim();
  db.prepare(
    `INSERT OR IGNORE INTO pick_history (
       pick_id, sport, graded_at, pick_label, tier, result,
       stake_units, stake_dollars, pl_units, pl_dollars,
       posted_odds, closing_odds, clv_pct
     ) VALUES (
       @pick_id, @sport, @graded_at, @pick_label, @tier, @result,
       @stake_units, @stake_dollars, @pl_units, @pl_dollars,
       @posted_odds, @closing_odds, @clv_pct
     )`,
  ).run({
    pick_id: r.id,
    sport: r.sport,
    graded_at: r.gradedAt ?? new Date().toISOString(),
    pick_label: label,
    tier: r.tier,
    result: r.result,
    stake_units: r.units,
    stake_dollars: r.stakeDollars,
    pl_units: plUnits,
    pl_dollars: plDollars,
    posted_odds: r.postedOddsAmerican,
    closing_odds: r.closingOddsAmerican,
    clv_pct: r.clvPct,
  });
}

export interface PickHistoryRow {
  pick_id: string;
  sport: string;
  graded_at: string;
  pick_label: string;
  tier: string;
  result: PickResult;
  stake_units: number;
  stake_dollars: number;
  pl_units: number;
  pl_dollars: number;
  posted_odds: number | null;
  closing_odds: number | null;
  clv_pct: number | null;
}

// All permanent history rows, optionally filtered by sport, newest first.
export function pickHistory(sport?: string): PickHistoryRow[] {
  const db = gradedDb();
  if (sport && sport.toUpperCase() !== "ALL") {
    return db
      .prepare("SELECT * FROM pick_history WHERE sport = ? ORDER BY graded_at DESC")
      .all(sport.toLowerCase()) as PickHistoryRow[];
  }
  return db.prepare("SELECT * FROM pick_history ORDER BY graded_at DESC").all() as PickHistoryRow[];
}

export function pickHistoryCount(): number {
  return (gradedDb().prepare("SELECT COUNT(*) AS n FROM pick_history").get() as { n: number }).n;
}

// Write the final-grade ledger side effects for a freshly-settled pick: append
// to the permanent pick_history and adjust the running bankroll. Idempotent on
// pick_id for history; the bankroll update is applied once per call, so callers
// must invoke this exactly once on the pending→final transition. settlePick
// drives this from the live-scoring job.
export function recordGradeLedger(id: string): void {
  const db = gradedDb();
  const row = getRawPick(id);
  if (!row || row.status !== "final" || !row.result) return;
  // Only adjust the bankroll if this pick isn't already in the permanent ledger
  // (guards against a double-apply if recordGradeLedger is called twice).
  const already = db.prepare("SELECT 1 FROM pick_history WHERE pick_id = ?").get(id);
  recordPickHistory(db, row);
  if (already) return;
  applyGradeToBankroll(db, {
    result: row.result,
    stakeDollars: row.stakeDollars,
    plUnits: row.pl ?? 0,
    americanOdds: row.pickMl,
  });
}

// Add any missing columns to an existing table (SQLite has no IF NOT EXISTS for
// ADD COLUMN). Idempotent and safe to run on every boot.
function ensureColumns(db: Database.Database, table: string, cols: Record<string, string>): void {
  const present = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name),
  );
  for (const [name, ddl] of Object.entries(cols)) {
    if (!present.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
  }
}

// Composite id keeps one row per (game, market, side) so re-running the slate
// upserts the same pick instead of duplicating it.
export function pickId(gameId: string, pickType: string, pickSide: string): string {
  return `${gameId}:${pickType}:${pickSide}`;
}

export interface UpsertPickInput {
  gameId: string;
  sport: string;
  gameDate: string;
  gameTimeEt: string;
  matchup: string;
  homeTeam: string;
  awayTeam: string;
  homeTeamFull: string;
  awayTeamFull: string;
  pickSide: string;
  pickTeam: string;
  pickTeamFull: string;
  pickType: string;
  pickLine: number | null;
  pickMl: number | null;
  pickBook: string | null;
  gameStartIso: string | null;
  tier: string;
  units: number;
  stakeDollars: number;
  pickWinProb: number | null;
  pickImpliedProb: number | null;
  edgePp: number | null;
  evPer100: number | null;
  confidence: number | null;
  fairMl: number | null;
}

// Insert a pick, or refresh its pre-game fields if it's still pending. Once a
// pick has moved past pending (in_progress / final) we never overwrite it — the
// graded result is sacred. Returns true if the row was written/updated.
export function upsertPick(input: UpsertPickInput): boolean {
  const db = gradedDb();
  const id = pickId(input.gameId, input.pickType, input.pickSide);
  const now = new Date().toISOString();

  const existing = db.prepare("SELECT status, locked FROM picks WHERE id = ?").get(id) as
    | { status: PickStatus; locked: 0 | 1 }
    | undefined;
  if (existing && existing.status !== "pending") return false;
  // A locked (bet-placed) pick is immutable for tier/stake/odds — never let a
  // slate recompute clobber it, even while it's still pending pre-game.
  if (existing && existing.locked) return false;

  if (existing) {
    // While still pending and unlocked we refresh pre-game fields, but the
    // posted odds + posted timestamp are sacred (captured at first posting) so
    // CLV is measured against the true posting price — never re-stamp them.
    db.prepare(
      `UPDATE picks SET
        gameDate=@gameDate, gameTimeEt=@gameTimeEt, matchup=@matchup,
        homeTeam=@homeTeam, awayTeam=@awayTeam, homeTeamFull=@homeTeamFull, awayTeamFull=@awayTeamFull,
        pickTeam=@pickTeam, pickTeamFull=@pickTeamFull, pickLine=@pickLine, pickMl=@pickMl, pickBook=@pickBook,
        gameStartIso=@gameStartIso,
        tier=@tier, units=@units, stakeDollars=@stakeDollars,
        pickWinProb=@pickWinProb, pickImpliedProb=@pickImpliedProb, edgePp=@edgePp, evPer100=@evPer100,
        confidence=@confidence, fairMl=@fairMl, updatedAt=@updatedAt
       WHERE id=@id`,
    ).run({ ...input, id, updatedAt: now });
    return true;
  }

  forceInsertPick(input);
  return true;
}

// Insert a pending pick row unconditionally, bypassing the upsert guards (status,
// lock, and the persistPicks units>0 / non-PASS filter). For the admin recovery
// path that seeds a clobbered-to-PASS pick the live engine no longer persists.
export function forceInsertPick(input: UpsertPickInput): string {
  const db = gradedDb();
  const id = pickId(input.gameId, input.pickType, input.pickSide);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO picks (
      id, gameId, sport, gameDate, gameTimeEt, matchup,
      homeTeam, awayTeam, homeTeamFull, awayTeamFull,
      pickSide, pickTeam, pickTeamFull, pickType, pickLine, pickMl, pickBook,
      gameStartIso, postedOddsAmerican, postedAt, lockStatus,
      tier, units, stakeDollars, pickWinProb, pickImpliedProb, edgePp, evPer100,
      confidence, fairMl, status, createdAt, updatedAt
    ) VALUES (
      @id, @gameId, @sport, @gameDate, @gameTimeEt, @matchup,
      @homeTeam, @awayTeam, @homeTeamFull, @awayTeamFull,
      @pickSide, @pickTeam, @pickTeamFull, @pickType, @pickLine, @pickMl, @pickBook,
      @gameStartIso, @postedOddsAmerican, @postedAt, 'open',
      @tier, @units, @stakeDollars, @pickWinProb, @pickImpliedProb, @edgePp, @evPer100,
      @confidence, @fairMl, 'pending', @createdAt, @updatedAt
    )`,
  ).run({ ...input, id, postedOddsAmerican: input.pickMl, postedAt: now, createdAt: now, updatedAt: now });
  return id;
}

// When a pick is locked, its frozen tier/stake/odds are authoritative — analytics
// and the board must show the LOCKED values, never a later recompute. Overlay
// them onto the canonical fields at read time so every consumer is consistent.
function applyLock(row: GradedPick | undefined): GradedPick | undefined {
  if (!row || !row.locked) return row;
  return {
    ...row,
    tier: row.lockedTier ?? row.tier,
    stakeDollars: row.lockedStake ?? row.stakeDollars,
    pickMl: row.lockedOdds ?? row.pickMl,
  };
}

export function getPick(id: string): GradedPick | undefined {
  return applyLock(gradedDb().prepare("SELECT * FROM picks WHERE id = ?").get(id) as GradedPick | undefined);
}

// Raw row without the locked-value overlay — for callers that need the actual
// stored tier/stake (e.g. confirmBet snapshotting). Internal.
function getRawPick(id: string): GradedPick | undefined {
  return gradedDb().prepare("SELECT * FROM picks WHERE id = ?").get(id) as GradedPick | undefined;
}

// Lock guard for the tier-recompute pipeline. Any code path that would re-tier,
// re-stake, or re-price a pick must call this first and bail when it returns the
// pick unchanged. A locked pick reflects a bet the user has actually placed, so
// its tier/stake/odds are sacred. Pure (no I/O) so it's trivially testable.
export function pickLockGuard<T extends { locked?: 0 | 1 | boolean }>(pick: T): { locked: boolean; pick: T } {
  return { locked: Boolean(pick.locked), pick };
}

// Snapshot the current tier/stake/odds into the locked* columns and freeze the
// row. Idempotent: a second call returns the already-frozen row without
// re-snapshotting (the first confirmation is authoritative).
export function confirmBet(id: string): GradedPick | undefined {
  const db = gradedDb();
  const row = getRawPick(id);
  if (!row) return undefined;
  if (row.locked) return applyLock(row);
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE picks SET locked=1, lockedAt=@lockedAt,
       lockedTier=@lockedTier, lockedStake=@lockedStake, lockedOdds=@lockedOdds,
       updatedAt=@updatedAt WHERE id=@id`,
  ).run({
    id,
    lockedAt: now,
    lockedTier: row.tier,
    lockedStake: row.stakeDollars,
    lockedOdds: row.pickMl,
    updatedAt: now,
  });
  return getPick(id);
}

export interface PickAuditRow {
  id: number;
  pickId: string;
  action: string;
  fromTier: string | null;
  toTier: string | null;
  fromOdds: number | null;
  toOdds: number | null;
  reason: string;
  createdAt: string;
}

export interface AdminLockOverride {
  tier: string;
  odds?: number;
  stake?: number;
  reason: string;
  // When the pick id isn't in the book (e.g. the live engine now scores it PASS,
  // so persistPicks never wrote it), hydrate the row from the live slate and
  // insert it before locking. Defaults to false to preserve the 404 behavior.
  seedFromLive?: boolean;
}

export interface AdminLockResult {
  pick: GradedPick;
  audit: PickAuditRow;
}

// Minimal shape of the live engine's BuiltPick that this module needs to seed a
// graded row. Kept structural (not an import) so gradedBook stays free of a
// static dependency on the slate orchestrator, which itself imports gradedBook.
export interface SeedBuiltPick {
  gameId: string;
  sport: string;
  gameDate: string;
  gameTimeEt: string;
  matchup: string;
  homeTeam: string;
  awayTeam: string;
  homeTeamFull: string;
  awayTeamFull: string;
  pickSide: string;
  pickTeam: string;
  pickTeamFull: string;
  pickType: string;
  pickMl: number | null;
  pickBook: string | null;
  gameStartIso?: string | null;
  verdictTier: string;
  units: number;
  kellyStakeDollars: number;
  pickWinProb: number | null;
  pickImpliedProb: number | null;
  edgePp: number | null;
  evPer100: number | null;
  confidence: number | null;
  fairMl: number | null;
}

export type SeedLookup = (id: string) => Promise<SeedBuiltPick | null | undefined>;

// Default seed resolver: hydrate the live engine's pick for this id. Dynamically
// imported to avoid a static circular import (orchestrator → gradedBook).
const defaultSeedLookup: SeedLookup = async (id) => {
  const { getAnyPick } = await import("./slate/orchestrator");
  const [gameId, pickType, pickSide] = id.split(":");
  const pick = await getAnyPick(gameId);
  if (!pick || pick.pickType !== pickType || pick.pickSide !== pickSide) return null;
  return pick;
};

// Map a live BuiltPick into an UpsertPickInput. Mirrors persistPicks exactly,
// including pickLine: null. Override fields are applied on top here so the
// inserted row already carries the corrected tier/odds/stake.
function seedToUpsertInput(pick: SeedBuiltPick, override: AdminLockOverride): UpsertPickInput {
  return {
    gameId: pick.gameId,
    sport: pick.sport,
    gameDate: pick.gameDate,
    gameTimeEt: pick.gameTimeEt,
    matchup: pick.matchup,
    homeTeam: pick.homeTeam,
    awayTeam: pick.awayTeam,
    homeTeamFull: pick.homeTeamFull,
    awayTeamFull: pick.awayTeamFull,
    pickSide: pick.pickSide,
    pickTeam: pick.pickTeam,
    pickTeamFull: pick.pickTeamFull,
    pickType: pick.pickType,
    pickLine: null,
    pickMl: override.odds ?? pick.pickMl,
    pickBook: pick.pickBook,
    gameStartIso: pick.gameStartIso ?? null,
    tier: override.tier,
    units: pick.units,
    stakeDollars: override.stake ?? pick.kellyStakeDollars,
    pickWinProb: pick.pickWinProb,
    pickImpliedProb: pick.pickImpliedProb,
    edgePp: pick.edgePp,
    evPer100: pick.evPer100,
    confidence: pick.confidence,
    fairMl: pick.fairMl,
  };
}

// Admin recovery path: override a pick's tier/odds/stake on the raw row, then
// snapshot+lock it via confirmBet, and record the change in pick_audit. Used to
// repair a pick whose stored tier was clobbered by a recompute before the user
// got to lock it (the original tier/odds are authoritative, not the recompute).
//
// When the id isn't in the book and override.seedFromLive is set, the row is
// hydrated from the live slate engine (a pick the engine now scores PASS is
// never persisted by persistPicks, so it can't be locked otherwise) and inserted
// with the override values applied before locking. Returns undefined when the
// pick id doesn't exist and can't be seeded.
export async function adminLockWithOverride(
  id: string,
  override: AdminLockOverride,
  seedLookup: SeedLookup = defaultSeedLookup,
): Promise<AdminLockResult | undefined> {
  const db = gradedDb();
  let before = getRawPick(id);
  if (!before) {
    if (!override.seedFromLive) return undefined;
    const live = await seedLookup(id);
    if (!live) return undefined;
    forceInsertPick(seedToUpsertInput(live, override));
    before = getRawPick(id)!;
  }

  const sets: string[] = [];
  const params: Record<string, unknown> = { id };
  if (override.tier !== undefined) {
    sets.push("tier=@tier");
    params.tier = override.tier;
  }
  if (override.odds !== undefined) {
    sets.push("pickMl=@pickMl");
    params.pickMl = override.odds;
  }
  if (override.stake !== undefined) {
    sets.push("stakeDollars=@stakeDollars");
    params.stakeDollars = override.stake;
  }
  if (sets.length > 0) {
    const now = new Date().toISOString();
    sets.push("updatedAt=@updatedAt");
    params.updatedAt = now;
    db.prepare(`UPDATE picks SET ${sets.join(", ")} WHERE id=@id`).run(params);
  }

  const pick = confirmBet(id)!;

  const auditAt = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO pick_audit (pickId, action, fromTier, toTier, fromOdds, toOdds, reason, createdAt)
       VALUES (@pickId, @action, @fromTier, @toTier, @fromOdds, @toOdds, @reason, @createdAt)`,
    )
    .run({
      pickId: id,
      action: "admin-lock",
      fromTier: before.tier,
      toTier: override.tier ?? before.tier,
      fromOdds: before.pickMl,
      toOdds: override.odds ?? before.pickMl,
      reason: override.reason,
      createdAt: auditAt,
    });
  const audit = db
    .prepare("SELECT * FROM pick_audit WHERE id = ?")
    .get(Number(info.lastInsertRowid)) as PickAuditRow;

  return { pick, audit };
}

// Open picks for a date that still need a live/score update (not yet final and
// actually staked). Used by the live-scoring poller.
export function openPicksForDate(date: string): GradedPick[] {
  return gradedDb()
    .prepare("SELECT * FROM picks WHERE gameDate = ? AND status != 'final' AND units > 0")
    .all(date) as GradedPick[];
}

// Picks whose closing line hasn't been captured yet (lockStatus='open') and that
// carry a known game-start time. Used by the lock worker to snapshot the close.
export function openLockPicksForDate(date: string): GradedPick[] {
  return gradedDb()
    .prepare(
      "SELECT * FROM picks WHERE gameDate = ? AND lockStatus = 'open' AND gameStartIso IS NOT NULL AND units > 0",
    )
    .all(date) as GradedPick[];
}

// Persist the closing-line snapshot + computed CLV on a pick and flip it to
// 'locked'. Idempotent at the call site (the worker only selects 'open' rows).
export function lockClosingLine(
  id: string,
  fields: {
    closingOddsAmerican: number;
    closingSource: string;
    clvPoints: number;
    clvPercent: number;
  },
): void {
  const now = new Date().toISOString();
  gradedDb()
    .prepare(
      `UPDATE picks SET closingOddsAmerican=@closingOddsAmerican, closingCapturedAt=@closingCapturedAt,
        closingSource=@closingSource, clvPoints=@clvPoints, clvPercent=@clvPercent,
        lockStatus='locked', updatedAt=@updatedAt WHERE id=@id`,
    )
    .run({ ...fields, id, closingCapturedAt: now, updatedAt: now });
}

export function picksForDate(date: string): GradedPick[] {
  const rows = gradedDb().prepare("SELECT * FROM picks WHERE gameDate = ? ORDER BY gameTimeEt").all(date) as GradedPick[];
  return rows.map((r) => applyLock(r)!);
}

// Update the live in-progress fields (score + status detail) without grading.
export function updateLive(
  id: string,
  fields: { status: PickStatus; liveAwayScore: number | null; liveHomeScore: number | null; liveStatusDetail: string | null },
): void {
  gradedDb()
    .prepare(
      `UPDATE picks SET status=@status, liveAwayScore=@liveAwayScore, liveHomeScore=@liveHomeScore,
        liveStatusDetail=@liveStatusDetail, updatedAt=@updatedAt WHERE id=@id`,
    )
    .run({ ...fields, id, updatedAt: new Date().toISOString() });
}

// Persist a final grade (result + P/L) on a row.
export function settlePick(
  id: string,
  fields: {
    finalAwayScore: number;
    finalHomeScore: number;
    result: PickResult;
    pl: number;
    clvPct: number | null;
    liveStatusDetail: string | null;
  },
): void {
  const now = new Date().toISOString();
  gradedDb()
    .prepare(
      `UPDATE picks SET status='final', finalAwayScore=@finalAwayScore, finalHomeScore=@finalHomeScore,
        liveAwayScore=@finalAwayScore, liveHomeScore=@finalHomeScore,
        result=@result, pl=@pl, clvPct=@clvPct, liveStatusDetail=@liveStatusDetail,
        lockStatus='final', gradedAt=@gradedAt, updatedAt=@updatedAt WHERE id=@id`,
    )
    .run({ ...fields, id, gradedAt: now, updatedAt: now });
}

export interface ClvAggregate {
  meanPct: number;
  positiveRatePct: number;
  captured: number; // rows with a captured closing line
  byTier: Array<{ tier: string; meanPct: number; captured: number }>;
}

// Aggregate captured-CLV figures from rows whose closing line has been snapshot
// (lockStatus locked/final → clvPercent is non-null). Optional sport/tier/since
// filters mirror the analytics dashboard. Empty book → zeros + empty byTier.
export function clvAggregate(opts: { sport?: string | null; tier?: string | null; since?: string | null } = {}): ClvAggregate {
  const clauses = ["clvPercent IS NOT NULL"];
  const params: Record<string, unknown> = {};
  if (opts.sport && opts.sport.toUpperCase() !== "ALL") {
    clauses.push("sport = @sport");
    params.sport = opts.sport.toLowerCase();
  }
  if (opts.tier && opts.tier.toUpperCase() !== "ALL") {
    clauses.push("tier = @tier");
    params.tier = opts.tier.toUpperCase();
  }
  if (opts.since) {
    clauses.push("gameDate >= @since");
    params.since = opts.since;
  }
  const rows = gradedDb()
    .prepare(`SELECT tier, clvPercent FROM picks WHERE ${clauses.join(" AND ")}`)
    .all(params) as Array<{ tier: string; clvPercent: number }>;

  if (rows.length === 0) return { meanPct: 0, positiveRatePct: 0, captured: 0, byTier: [] };

  const sum = rows.reduce((a, r) => a + r.clvPercent, 0);
  const positive = rows.filter((r) => r.clvPercent > 0).length;

  const byTierMap = new Map<string, number[]>();
  for (const r of rows) {
    if (!byTierMap.has(r.tier)) byTierMap.set(r.tier, []);
    byTierMap.get(r.tier)!.push(r.clvPercent);
  }
  const byTier = [...byTierMap.entries()].map(([tier, vals]) => ({
    tier,
    meanPct: Math.round((vals.reduce((a, v) => a + v, 0) / vals.length) * 100) / 100,
    captured: vals.length,
  }));

  return {
    meanPct: Math.round((sum / rows.length) * 100) / 100,
    positiveRatePct: Math.round((positive / rows.length) * 1000) / 10,
    captured: rows.length,
    byTier,
  };
}

// All graded (final) picks, optionally filtered by sport, newest first.
export function gradedPicks(sport?: string): GradedPick[] {
  const db = gradedDb();
  if (sport && sport.toUpperCase() !== "ALL") {
    const rows = db
      .prepare("SELECT * FROM picks WHERE status='final' AND sport=? ORDER BY gameDate DESC, gameTimeEt DESC")
      .all(sport.toLowerCase()) as GradedPick[];
    return rows.map((r) => applyLock(r)!);
  }
  const rows = db
    .prepare("SELECT * FROM picks WHERE status='final' ORDER BY gameDate DESC, gameTimeEt DESC")
    .all() as GradedPick[];
  return rows.map((r) => applyLock(r)!);
}
