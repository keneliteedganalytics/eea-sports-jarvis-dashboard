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
      clv_pct REAL,
      archived_at TEXT,
      final_away_score INTEGER,
      final_home_score INTEGER,
      home_team TEXT,
      away_team TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pick_history_sport ON pick_history(sport);
    CREATE INDEX IF NOT EXISTS idx_pick_history_graded_at ON pick_history(graded_at);
    -- NOTE: idx_pick_history_archived_at is created *after* ensureColumns below,
    -- not here. On an existing (pre-v6.5) DB the CREATE TABLE above is a no-op, so
    -- archived_at doesn't exist yet; indexing it in this batch threw "no such
    -- column: archived_at" and aborted the entire boot before the column was
    -- ever added (the v6.5.1 outage). The index must wait for the column.
    -- Player-prop pick ledger. A separate domain from game-line picks (ML/spread/
    -- total): one row per (game, player, market, side). Mirrors pick_history's
    -- append-only, never-deleted contract so prop analytics survive a picks wipe.
    CREATE TABLE IF NOT EXISTS prop_picks (
      pick_id TEXT PRIMARY KEY,
      sport TEXT,
      game_id TEXT,
      player_name TEXT,
      player_id TEXT,
      team TEXT,
      opponent TEXT,
      market_type TEXT,
      line REAL,
      side TEXT,
      posted_odds INTEGER,
      closing_odds INTEGER,
      posted_at TEXT,
      graded_at TEXT,
      result TEXT,
      actual_value REAL,
      pl_units REAL,
      pl_dollars REAL,
      tier TEXT,
      confidence INTEGER,
      edge_pp REAL,
      data_quality_tier TEXT,
      clv_pct REAL
    );
    CREATE INDEX IF NOT EXISTS idx_prop_picks_sport ON prop_picks(sport);
    CREATE INDEX IF NOT EXISTS idx_prop_picks_market ON prop_picks(market_type);
    CREATE INDEX IF NOT EXISTS idx_prop_picks_player ON prop_picks(player_name);
    -- Raw multi-book prop offerings (v6.7). One row per book per market per
    -- player so the pick builder can shop the best price. Refreshed each ingest
    -- run; not a permanent ledger (these are pre-pick quotes, not graded bets).
    -- Composite primary key dedupes a re-ingest of the same quote.
    CREATE TABLE IF NOT EXISTS prop_offers (
      event_id TEXT,
      sport TEXT,
      game_date TEXT,
      player_name TEXT,
      player_id TEXT,
      team TEXT,
      market TEXT,
      line REAL,
      over_price INTEGER,
      under_price INTEGER,
      book TEXT,
      fetched_at TEXT,
      PRIMARY KEY (event_id, market, player_name, book)
    );
    CREATE INDEX IF NOT EXISTS idx_prop_offers_date ON prop_offers(game_date);
    CREATE INDEX IF NOT EXISTS idx_prop_offers_event ON prop_offers(event_id);
    CREATE INDEX IF NOT EXISTS idx_prop_offers_lookup ON prop_offers(player_name, market);
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
  // Migrate pre-archive pick_history rows (v6.5): the archive + final-score
  // columns. Mirror of migrations/0004_archive_props.sql.
  ensureColumns(sqlite, "pick_history", {
    archived_at: "TEXT",
    final_away_score: "INTEGER",
    final_home_score: "INTEGER",
    home_team: "TEXT",
    away_team: "TEXT",
  });
  // archived_at now exists (fresh CREATE TABLE or just-added by ensureColumns), so
  // the archive index is safe to build. Kept out of the upfront exec() block on
  // purpose — see the NOTE there.
  sqlite.exec(
    "CREATE INDEX IF NOT EXISTS idx_pick_history_archived_at ON pick_history(archived_at);",
  );
  // v6.7: prop picks gain a stored simulation summary + hit-rate snapshot + the
  // best-book price the pick was shopped to. Mirror of migrations/0005_prop_engine.sql.
  ensureColumns(sqlite, "prop_picks", {
    model_prob: "REAL",
    sim_median: "REAL",
    sim_p25: "REAL",
    sim_p75: "REAL",
    sim_mean: "REAL",
    sim_trials: "INTEGER",
    hit_rates_json: "TEXT",
    matchup_json: "TEXT",
    best_book: "TEXT",
    best_price: "INTEGER",
    market_label: "TEXT",
    stake_units: "REAL",
    hundred_club: "INTEGER NOT NULL DEFAULT 0",
  });
  _db = sqlite;
  initBankrollState(sqlite);
  backfillPickHistory(sqlite);
  backfillArchiveFields(sqlite);
  return _db;
}

// One-time archive backfill (v6.5). For any pick_history row missing the final
// score / team columns, hydrate them from the matching picks row (the original
// final score is sacred there). Set archived_at for already-graded rows: the
// slate is "in-flight only", so a graded pick is archived at graded_at + 6h for
// rows that predate the immediate-archive transition, immediately otherwise.
// Idempotent: only fills NULLs, never overwrites an existing archived_at.
function backfillArchiveFields(db: Database.Database): void {
  const rows = db
    .prepare(
      `SELECT h.pick_id, h.graded_at, h.archived_at, p.finalAwayScore AS fa, p.finalHomeScore AS fh,
              p.homeTeam AS ht, p.awayTeam AS at
       FROM pick_history h LEFT JOIN picks p ON p.id = h.pick_id
       WHERE h.archived_at IS NULL OR h.final_away_score IS NULL`,
    )
    .all() as Array<{
    pick_id: string;
    graded_at: string | null;
    archived_at: string | null;
    fa: number | null;
    fh: number | null;
    ht: string | null;
    at: string | null;
  }>;
  const upd = db.prepare(
    `UPDATE pick_history SET
       final_away_score = COALESCE(final_away_score, @fa),
       final_home_score = COALESCE(final_home_score, @fh),
       home_team = COALESCE(home_team, @ht),
       away_team = COALESCE(away_team, @at),
       archived_at = COALESCE(archived_at, @archived_at)
     WHERE pick_id = @pick_id`,
  );
  const tx = db.transaction(() => {
    for (const r of rows) {
      let archivedAt: string | null = r.archived_at;
      if (!archivedAt && r.graded_at) {
        archivedAt = new Date(new Date(r.graded_at).getTime() + 6 * 60 * 60_000).toISOString();
      }
      upd.run({
        pick_id: r.pick_id,
        fa: r.fa,
        fh: r.fh,
        ht: r.ht,
        at: r.at,
        archived_at: archivedAt,
      });
    }
  });
  tx();
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
  // Immediate archive: a graded (final) pick leaves the in-flight slate the
  // moment it settles, so archived_at = graded_at.
  const gradedAt = r.gradedAt ?? new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO pick_history (
       pick_id, sport, graded_at, pick_label, tier, result,
       stake_units, stake_dollars, pl_units, pl_dollars,
       posted_odds, closing_odds, clv_pct,
       archived_at, final_away_score, final_home_score, home_team, away_team
     ) VALUES (
       @pick_id, @sport, @graded_at, @pick_label, @tier, @result,
       @stake_units, @stake_dollars, @pl_units, @pl_dollars,
       @posted_odds, @closing_odds, @clv_pct,
       @archived_at, @final_away_score, @final_home_score, @home_team, @away_team
     )`,
  ).run({
    pick_id: r.id,
    sport: r.sport,
    graded_at: gradedAt,
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
    archived_at: gradedAt,
    final_away_score: r.finalAwayScore,
    final_home_score: r.finalHomeScore,
    home_team: r.homeTeam,
    away_team: r.awayTeam,
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
  archived_at: string | null;
  final_away_score: number | null;
  final_home_score: number | null;
  home_team: string | null;
  away_team: string | null;
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

export interface ArchiveItem {
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
  final_score: string | null;
}

export interface ArchiveQuery {
  sport?: string | null; // "ALL" | mlb/nhl/nba/soccer
  since?: string | null; // YYYY-MM-DD inclusive lower bound on graded_at
  result?: string | null; // "ALL" | W | L | P
  tier?: string | null; // "ALL" | SNIPER | EDGE | RECON
  limit?: number;
  offset?: number;
}

export interface ArchivePage {
  items: ArchiveItem[];
  total: number;
  limit: number;
  offset: number;
}

// Compose the "Away 3 — Home 2" final-score string from stored scores + teams.
function composeFinalScore(r: PickHistoryRow): string | null {
  if (r.final_away_score === null || r.final_home_score === null) return null;
  const away = r.away_team ?? "AWY";
  const home = r.home_team ?? "HOM";
  return `${away} ${r.final_away_score} — ${home} ${r.final_home_score}`;
}

// Paginated archived picks (archived_at IS NOT NULL), newest-graded first, with
// optional sport / result / tier / since filters. Empty book → empty page.
export function archivedPicks(q: ArchiveQuery = {}): ArchivePage {
  const db = gradedDb();
  const clauses = ["archived_at IS NOT NULL"];
  const params: Record<string, unknown> = {};
  if (q.sport && q.sport.toUpperCase() !== "ALL") {
    clauses.push("sport = @sport");
    params.sport = q.sport.toLowerCase();
  }
  if (q.result && q.result.toUpperCase() !== "ALL") {
    clauses.push("result = @result");
    params.result = q.result.toUpperCase();
  }
  if (q.tier && q.tier.toUpperCase() !== "ALL") {
    clauses.push("tier = @tier");
    params.tier = q.tier.toUpperCase();
  }
  if (q.since) {
    clauses.push("graded_at >= @since");
    params.since = q.since;
  }
  const where = clauses.join(" AND ");
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM pick_history WHERE ${where}`).get(params) as { n: number }
  ).n;
  const limit = Math.min(Math.max(Number(q.limit ?? 50) || 50, 1), 200);
  const offset = Math.max(Number(q.offset ?? 0) || 0, 0);
  const rows = db
    .prepare(
      `SELECT * FROM pick_history WHERE ${where} ORDER BY graded_at DESC LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit, offset }) as PickHistoryRow[];
  const items: ArchiveItem[] = rows.map((r) => ({
    pick_id: r.pick_id,
    sport: r.sport,
    graded_at: r.graded_at,
    pick_label: r.pick_label,
    tier: r.tier,
    result: r.result,
    stake_units: r.stake_units,
    stake_dollars: r.stake_dollars,
    pl_units: r.pl_units,
    pl_dollars: r.pl_dollars,
    posted_odds: r.posted_odds,
    closing_odds: r.closing_odds,
    clv_pct: r.clv_pct,
    final_score: composeFinalScore(r),
  }));
  return { items, total, limit, offset };
}

// Set of archived pick ids for a date's slate exclusion. A pick whose graded
// row is archived (always true once final) must drop off the in-flight board.
export function archivedPickIds(): Set<string> {
  const rows = gradedDb()
    .prepare("SELECT pick_id FROM pick_history WHERE archived_at IS NOT NULL")
    .all() as Array<{ pick_id: string }>;
  return new Set(rows.map((r) => r.pick_id));
}

// ── Player props ──────────────────────────────────────────────────────────
// A separate domain from game-line picks. Storage lives here (one db file), but
// the grading rule + edge model live in server/sports/props/*.

export type PropSide = "over" | "under";

export interface PropPickRow {
  pick_id: string;
  sport: string;
  game_id: string;
  player_name: string;
  player_id: string | null;
  team: string | null;
  opponent: string | null;
  market_type: string;
  line: number;
  side: PropSide;
  posted_odds: number | null;
  closing_odds: number | null;
  posted_at: string | null;
  graded_at: string | null;
  result: PickResult | null;
  actual_value: number | null;
  pl_units: number | null;
  pl_dollars: number | null;
  tier: string;
  confidence: number | null;
  edge_pp: number | null;
  data_quality_tier: string | null;
  clv_pct: number | null;
  // v6.7 simulation + line-shopping fields.
  model_prob: number | null;
  sim_median: number | null;
  sim_p25: number | null;
  sim_p75: number | null;
  sim_mean: number | null;
  sim_trials: number | null;
  hit_rates_json: string | null;
  matchup_json: string | null;
  best_book: string | null;
  best_price: number | null;
  market_label: string | null;
  stake_units: number | null;
  hundred_club: number | null;
}

export interface UpsertPropInput {
  pick_id: string;
  sport: string;
  game_id: string;
  player_name: string;
  player_id?: string | null;
  team?: string | null;
  opponent?: string | null;
  market_type: string;
  line: number;
  side: PropSide;
  posted_odds?: number | null;
  posted_at?: string | null;
  tier?: string;
  confidence?: number | null;
  edge_pp?: number | null;
  data_quality_tier?: string | null;
  model_prob?: number | null;
  sim_median?: number | null;
  sim_p25?: number | null;
  sim_p75?: number | null;
  sim_mean?: number | null;
  sim_trials?: number | null;
  hit_rates_json?: string | null;
  matchup_json?: string | null;
  best_book?: string | null;
  best_price?: number | null;
  market_label?: string | null;
  stake_units?: number | null;
  hundred_club?: boolean | number | null;
}

// Insert or refresh a prop pick. A prop already graded (result set) is sacred and
// never overwritten — same contract as game-line picks. Returns the pick_id.
export function upsertPropPick(input: UpsertPropInput): string {
  const db = gradedDb();
  const existing = db.prepare("SELECT result FROM prop_picks WHERE pick_id = ?").get(input.pick_id) as
    | { result: string | null }
    | undefined;
  if (existing && existing.result) return input.pick_id;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO prop_picks (
       pick_id, sport, game_id, player_name, player_id, team, opponent,
       market_type, line, side, posted_odds, posted_at,
       tier, confidence, edge_pp, data_quality_tier,
       model_prob, sim_median, sim_p25, sim_p75, sim_mean, sim_trials,
       hit_rates_json, matchup_json, best_book, best_price, market_label,
       stake_units, hundred_club
     ) VALUES (
       @pick_id, @sport, @game_id, @player_name, @player_id, @team, @opponent,
       @market_type, @line, @side, @posted_odds, @posted_at,
       @tier, @confidence, @edge_pp, @data_quality_tier,
       @model_prob, @sim_median, @sim_p25, @sim_p75, @sim_mean, @sim_trials,
       @hit_rates_json, @matchup_json, @best_book, @best_price, @market_label,
       @stake_units, @hundred_club
     )
     ON CONFLICT(pick_id) DO UPDATE SET
       line=@line, side=@side, posted_odds=@posted_odds,
       tier=@tier, confidence=@confidence, edge_pp=@edge_pp,
       data_quality_tier=@data_quality_tier,
       model_prob=@model_prob, sim_median=@sim_median, sim_p25=@sim_p25,
       sim_p75=@sim_p75, sim_mean=@sim_mean, sim_trials=@sim_trials,
       hit_rates_json=@hit_rates_json, matchup_json=@matchup_json,
       best_book=@best_book, best_price=@best_price, market_label=@market_label,
       stake_units=@stake_units, hundred_club=@hundred_club`,
  ).run({
    pick_id: input.pick_id,
    sport: input.sport.toLowerCase(),
    game_id: input.game_id,
    player_name: input.player_name,
    player_id: input.player_id ?? null,
    team: input.team ?? null,
    opponent: input.opponent ?? null,
    market_type: input.market_type,
    line: input.line,
    side: input.side,
    posted_odds: input.posted_odds ?? null,
    posted_at: input.posted_at ?? now,
    tier: input.tier ?? "RECON",
    confidence: input.confidence ?? null,
    edge_pp: input.edge_pp ?? null,
    data_quality_tier: input.data_quality_tier ?? null,
    model_prob: input.model_prob ?? null,
    sim_median: input.sim_median ?? null,
    sim_p25: input.sim_p25 ?? null,
    sim_p75: input.sim_p75 ?? null,
    sim_mean: input.sim_mean ?? null,
    sim_trials: input.sim_trials ?? null,
    hit_rates_json: input.hit_rates_json ?? null,
    matchup_json: input.matchup_json ?? null,
    best_book: input.best_book ?? null,
    best_price: input.best_price ?? null,
    market_label: input.market_label ?? null,
    stake_units: input.stake_units ?? null,
    hundred_club: input.hundred_club ? 1 : 0,
  });
  return input.pick_id;
}

export function getPropPick(id: string): PropPickRow | undefined {
  return gradedDb().prepare("SELECT * FROM prop_picks WHERE pick_id = ?").get(id) as
    | PropPickRow
    | undefined;
}

// Active (ungraded) prop picks for a sport+date. Mirrors the slate board shape.
export function propBoard(opts: { sport?: string | null; date?: string | null } = {}): PropPickRow[] {
  const db = gradedDb();
  const clauses = ["result IS NULL"];
  const params: Record<string, unknown> = {};
  if (opts.sport && opts.sport.toUpperCase() !== "ALL") {
    clauses.push("sport = @sport");
    params.sport = opts.sport.toLowerCase();
  }
  if (opts.date) {
    clauses.push("substr(posted_at, 1, 10) = @date");
    params.date = opts.date;
  }
  return db
    .prepare(`SELECT * FROM prop_picks WHERE ${clauses.join(" AND ")} ORDER BY posted_at DESC`)
    .all(params) as PropPickRow[];
}

// All graded prop picks for analytics, optional sport + since filters.
export function gradedPropPicks(opts: { sport?: string | null; since?: string | null } = {}): PropPickRow[] {
  const db = gradedDb();
  const clauses = ["result IS NOT NULL"];
  const params: Record<string, unknown> = {};
  if (opts.sport && opts.sport.toUpperCase() !== "ALL") {
    clauses.push("sport = @sport");
    params.sport = opts.sport.toLowerCase();
  }
  if (opts.since) {
    clauses.push("graded_at >= @since");
    params.since = opts.since;
  }
  return db
    .prepare(`SELECT * FROM prop_picks WHERE ${clauses.join(" AND ")} ORDER BY graded_at DESC`)
    .all(params) as PropPickRow[];
}

// Persist a prop grade (result + actual stat + P/L). Idempotent at the call site.
export function settlePropPick(
  id: string,
  fields: { result: PickResult; actualValue: number; plUnits: number; plDollars: number },
): void {
  const now = new Date().toISOString();
  gradedDb()
    .prepare(
      `UPDATE prop_picks SET result=@result, actual_value=@actual_value,
        pl_units=@pl_units, pl_dollars=@pl_dollars, graded_at=@graded_at WHERE pick_id=@id`,
    )
    .run({
      id,
      result: fields.result,
      actual_value: fields.actualValue,
      pl_units: fields.plUnits,
      pl_dollars: fields.plDollars,
      graded_at: now,
    });
}

// ── Prop offers (raw multi-book quotes) ─────────────────────────────────────
// Storage for the line-shopping table. One row per book per market per player;
// re-ingesting the same quote upserts it. Not graded — these are pre-pick.

export interface PropOfferRow {
  event_id: string;
  sport: string;
  game_date: string | null;
  player_name: string;
  player_id: string | null;
  team: string | null;
  market: string;
  line: number;
  over_price: number | null;
  under_price: number | null;
  book: string;
  fetched_at: string | null;
}

export interface UpsertPropOfferInput {
  event_id: string;
  sport: string;
  game_date?: string | null;
  player_name: string;
  player_id?: string | null;
  team?: string | null;
  market: string;
  line: number;
  over_price?: number | null;
  under_price?: number | null;
  book: string;
}

export function upsertPropOffer(input: UpsertPropOfferInput): void {
  gradedDb()
    .prepare(
      `INSERT INTO prop_offers (
         event_id, sport, game_date, player_name, player_id, team,
         market, line, over_price, under_price, book, fetched_at
       ) VALUES (
         @event_id, @sport, @game_date, @player_name, @player_id, @team,
         @market, @line, @over_price, @under_price, @book, @fetched_at
       )
       ON CONFLICT(event_id, market, player_name, book) DO UPDATE SET
         line=@line, over_price=@over_price, under_price=@under_price,
         game_date=@game_date, team=@team, player_id=@player_id, fetched_at=@fetched_at`,
    )
    .run({
      event_id: input.event_id,
      sport: input.sport.toLowerCase(),
      game_date: input.game_date ?? null,
      player_name: input.player_name,
      player_id: input.player_id ?? null,
      team: input.team ?? null,
      market: input.market,
      line: input.line,
      over_price: input.over_price ?? null,
      under_price: input.under_price ?? null,
      book: input.book,
      fetched_at: new Date().toISOString(),
    });
}

// All offers for a given operating date (optionally a sport). One row per book.
export function propOffersForDate(date: string, sport?: string | null): PropOfferRow[] {
  const db = gradedDb();
  const clauses = ["game_date = @date"];
  const params: Record<string, unknown> = { date };
  if (sport && sport.toUpperCase() !== "ALL") {
    clauses.push("sport = @sport");
    params.sport = sport.toLowerCase();
  }
  return db
    .prepare(`SELECT * FROM prop_offers WHERE ${clauses.join(" AND ")} ORDER BY player_name, market`)
    .all(params) as PropOfferRow[];
}

// Count of stored offers for a date (optionally a sport). Used by the ingest
// diagnostic endpoint to confirm the upstream pull actually landed rows.
export function countPropOffersForDate(date: string, sport?: string | null): number {
  const db = gradedDb();
  const clauses = ["game_date = @date"];
  const params: Record<string, unknown> = { date };
  if (sport && sport.toUpperCase() !== "ALL") {
    clauses.push("sport = @sport");
    params.sport = sport.toLowerCase();
  }
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM prop_offers WHERE ${clauses.join(" AND ")}`)
    .get(params) as { n: number };
  return row?.n ?? 0;
}

// Count of prop picks whose game falls on a date. prop_picks has no game_date
// column (it's dated by posted_at), so we resolve the slate date by joining the
// pick's game_id to the event's offers, which do carry game_date.
export function countPropPicksForDate(date: string, sport?: string | null): number {
  const db = gradedDb();
  const clauses = ["o.game_date = @date"];
  const params: Record<string, unknown> = { date };
  if (sport && sport.toUpperCase() !== "ALL") {
    clauses.push("p.sport = @sport");
    params.sport = sport.toLowerCase();
  }
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT p.pick_id) AS n
         FROM prop_picks p
         JOIN prop_offers o ON o.event_id = p.game_id
        WHERE ${clauses.join(" AND ")}`,
    )
    .get(params) as { n: number };
  return row?.n ?? 0;
}

// All offers across books for one (event, player, market) — the line-shopping set.
export function propOffersFor(eventId: string, playerName: string, market: string): PropOfferRow[] {
  return gradedDb()
    .prepare(
      "SELECT * FROM prop_offers WHERE event_id=? AND player_name=? AND market=? ORDER BY book",
    )
    .all(eventId, playerName, market) as PropOfferRow[];
}

// Persist a resolved MLB Stats player id back onto the matching offer rows so the
// next build cycle reads it from storage instead of re-querying the name lookup.
// Updates every book's row for the (event, market, player) whose id is still null.
// Stored as TEXT to match the column; the builder coerces back to a number.
export function setPropOfferPlayerId(
  eventId: string,
  market: string,
  playerName: string,
  playerId: number,
): void {
  gradedDb()
    .prepare(
      `UPDATE prop_offers SET player_id = @player_id
        WHERE event_id = @event_id AND market = @market
          AND player_name = @player_name AND player_id IS NULL`,
    )
    .run({
      player_id: String(playerId),
      event_id: eventId,
      market,
      player_name: playerName,
    });
}

// Wipe offers for a date before a fresh ingest (offers are quotes, not a ledger).
export function clearPropOffersForDate(date: string): void {
  gradedDb().prepare("DELETE FROM prop_offers WHERE game_date = ?").run(date);
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
    if (present.has(name)) continue;
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
    } catch (err) {
      // SQLite has no "ADD COLUMN IF NOT EXISTS". The PRAGMA check above already
      // skips existing columns, but swallow a racing "duplicate column" so a
      // concurrent boot can't abort the migration — any other error is real.
      const msg = (err as Error).message ?? "";
      if (!/duplicate column name/i.test(msg)) throw err;
    }
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
