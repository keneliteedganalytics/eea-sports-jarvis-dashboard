// Graded book — the desk's real, settled betting record. Every actionable pick
// the engine surfaces is persisted here; an ESPN-fed live-scoring job updates
// each row through pending → in_progress → final and grades it (W/L/P + P/L).
// There is NO seed data: an empty book renders empty KPIs and "No graded picks
// yet" until a real pick settles against a real final score.
//
// File path is configurable via GRADED_BOOK_PATH (default data/graded_book.db).
// Railway has ephemeral disk — see DEPLOY.md for the volume-mount follow-up.

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type PickStatus = "pending" | "in_progress" | "final";
export type PickResult = "W" | "L" | "P";

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
}

function dbPath(): string {
  return process.env.GRADED_BOOK_PATH || path.join(process.cwd(), "data", "graded_book.db");
}

let _db: Database.Database | null = null;

export function gradedDb(): Database.Database {
  if (_db) return _db;
  const file = dbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
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
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_picks_gameDate ON picks(gameDate);
    CREATE INDEX IF NOT EXISTS idx_picks_status ON picks(status);
    CREATE INDEX IF NOT EXISTS idx_picks_sport ON picks(sport);
  `);
  _db = sqlite;
  return _db;
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

  const existing = db.prepare("SELECT status FROM picks WHERE id = ?").get(id) as
    | { status: PickStatus }
    | undefined;
  if (existing && existing.status !== "pending") return false;

  if (existing) {
    db.prepare(
      `UPDATE picks SET
        gameDate=@gameDate, gameTimeEt=@gameTimeEt, matchup=@matchup,
        homeTeam=@homeTeam, awayTeam=@awayTeam, homeTeamFull=@homeTeamFull, awayTeamFull=@awayTeamFull,
        pickTeam=@pickTeam, pickTeamFull=@pickTeamFull, pickLine=@pickLine, pickMl=@pickMl, pickBook=@pickBook,
        tier=@tier, units=@units, stakeDollars=@stakeDollars,
        pickWinProb=@pickWinProb, pickImpliedProb=@pickImpliedProb, edgePp=@edgePp, evPer100=@evPer100,
        confidence=@confidence, fairMl=@fairMl, updatedAt=@updatedAt
       WHERE id=@id`,
    ).run({ ...input, id, updatedAt: now });
    return true;
  }

  db.prepare(
    `INSERT INTO picks (
      id, gameId, sport, gameDate, gameTimeEt, matchup,
      homeTeam, awayTeam, homeTeamFull, awayTeamFull,
      pickSide, pickTeam, pickTeamFull, pickType, pickLine, pickMl, pickBook,
      tier, units, stakeDollars, pickWinProb, pickImpliedProb, edgePp, evPer100,
      confidence, fairMl, status, createdAt, updatedAt
    ) VALUES (
      @id, @gameId, @sport, @gameDate, @gameTimeEt, @matchup,
      @homeTeam, @awayTeam, @homeTeamFull, @awayTeamFull,
      @pickSide, @pickTeam, @pickTeamFull, @pickType, @pickLine, @pickMl, @pickBook,
      @tier, @units, @stakeDollars, @pickWinProb, @pickImpliedProb, @edgePp, @evPer100,
      @confidence, @fairMl, 'pending', @createdAt, @updatedAt
    )`,
  ).run({ ...input, id, createdAt: now, updatedAt: now });
  return true;
}

export function getPick(id: string): GradedPick | undefined {
  return gradedDb().prepare("SELECT * FROM picks WHERE id = ?").get(id) as GradedPick | undefined;
}

// Open picks for a date that still need a live/score update (not yet final and
// actually staked). Used by the live-scoring poller.
export function openPicksForDate(date: string): GradedPick[] {
  return gradedDb()
    .prepare("SELECT * FROM picks WHERE gameDate = ? AND status != 'final' AND units > 0")
    .all(date) as GradedPick[];
}

export function picksForDate(date: string): GradedPick[] {
  return gradedDb().prepare("SELECT * FROM picks WHERE gameDate = ? ORDER BY gameTimeEt").all(date) as GradedPick[];
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
        gradedAt=@gradedAt, updatedAt=@updatedAt WHERE id=@id`,
    )
    .run({ ...fields, id, gradedAt: now, updatedAt: now });
}

// All graded (final) picks, optionally filtered by sport, newest first.
export function gradedPicks(sport?: string): GradedPick[] {
  const db = gradedDb();
  if (sport && sport.toUpperCase() !== "ALL") {
    return db
      .prepare("SELECT * FROM picks WHERE status='final' AND sport=? ORDER BY gameDate DESC, gameTimeEt DESC")
      .all(sport.toLowerCase()) as GradedPick[];
  }
  return db
    .prepare("SELECT * FROM picks WHERE status='final' ORDER BY gameDate DESC, gameTimeEt DESC")
    .all() as GradedPick[];
}
