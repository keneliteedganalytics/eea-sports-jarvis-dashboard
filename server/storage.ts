import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { and, desc, eq, gte } from "drizzle-orm";
import {
  games,
  oddsSnapshots,
  predictions,
  outcomes,
  slates,
  hitRateCache,
  type Game,
  type InsertGame,
  type OddsSnapshot,
  type InsertOddsSnapshot,
  type Prediction,
  type InsertPrediction,
  type Outcome,
  type InsertOutcome,
  type Slate,
  type InsertSlate,
  type HitRateCacheRow,
  type InsertHitRateCache,
} from "@shared/schema";

const sqlite = new Database("data.db");
sqlite.pragma("journal_mode = WAL");

export const db = drizzle(sqlite);

// Create tables if they don't exist. The synchronous better-sqlite3 driver
// lets us run DDL at boot — avoids a separate migration step for the demo.
export function initSchema(): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      sport TEXT NOT NULL,
      home_team TEXT NOT NULL,
      away_team TEXT NOT NULL,
      start_time_utc TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled',
      slate_date_et TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS odds_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      book TEXT NOT NULL,
      side TEXT NOT NULL,
      american_price INTEGER NOT NULL,
      ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      is_opener INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS predictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      formula_version TEXT NOT NULL,
      side TEXT NOT NULL,
      model_prob REAL NOT NULL,
      market_prob REAL NOT NULL,
      edge_pp REAL NOT NULL,
      ev_per_dollar REAL NOT NULL,
      kelly_units REAL NOT NULL,
      kelly_dollars REAL NOT NULL,
      tier TEXT NOT NULL,
      confidence INTEGER NOT NULL,
      raw_features_json TEXT NOT NULL DEFAULT '{}',
      ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL UNIQUE,
      final_home_score INTEGER,
      final_away_score INTEGER,
      winner_side TEXT,
      closed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS slates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sport TEXT NOT NULL,
      date_et TEXT NOT NULL,
      pick_count INTEGER NOT NULL DEFAULT 0,
      locked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS formula_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sport TEXT NOT NULL,
      version TEXT NOT NULL,
      params_json TEXT NOT NULL DEFAULT '{}',
      effective_from TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audio_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL UNIQUE,
      text TEXT NOT NULL,
      voice_id TEXT NOT NULL,
      model TEXT NOT NULL,
      mp3_path TEXT NOT NULL,
      ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS hit_rate_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sport TEXT NOT NULL,
      tier TEXT NOT NULL,
      window_days INTEGER NOT NULL,
      wins INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0,
      pushes INTEGER NOT NULL DEFAULT 0,
      units_won REAL NOT NULL DEFAULT 0,
      refreshed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

export const storage = {
  // ── games ──
  upsertGame(g: InsertGame): void {
    db.insert(games)
      .values(g)
      .onConflictDoUpdate({
        target: games.id,
        set: { status: g.status ?? "scheduled", startTimeUtc: g.startTimeUtc, slateDateEt: g.slateDateEt },
      })
      .run();
  },
  getGame(id: string): Game | undefined {
    return db.select().from(games).where(eq(games.id, id)).get();
  },
  gamesForSlate(sport: string, dateEt: string): Game[] {
    return db
      .select()
      .from(games)
      .where(and(eq(games.sport, sport), eq(games.slateDateEt, dateEt)))
      .all();
  },

  // ── odds snapshots ──
  insertOddsSnapshot(s: InsertOddsSnapshot): void {
    db.insert(oddsSnapshots).values(s).run();
  },
  snapshotsForGame(gameId: string): OddsSnapshot[] {
    return db
      .select()
      .from(oddsSnapshots)
      .where(eq(oddsSnapshots.gameId, gameId))
      .orderBy(desc(oddsSnapshots.ts))
      .all();
  },
  openerForGame(gameId: string, side: string): OddsSnapshot | undefined {
    return db
      .select()
      .from(oddsSnapshots)
      .where(and(eq(oddsSnapshots.gameId, gameId), eq(oddsSnapshots.side, side), eq(oddsSnapshots.isOpener, true)))
      .get();
  },

  // ── predictions ──
  upsertPrediction(p: InsertPrediction): Prediction {
    return db.insert(predictions).values(p).returning().get();
  },
  predictionsForGame(gameId: string): Prediction[] {
    return db.select().from(predictions).where(eq(predictions.gameId, gameId)).orderBy(desc(predictions.ts)).all();
  },
  latestPredictions(): Prediction[] {
    return db.select().from(predictions).orderBy(desc(predictions.ts)).all();
  },

  // ── outcomes ──
  upsertOutcome(o: InsertOutcome): void {
    db.insert(outcomes)
      .values(o)
      .onConflictDoUpdate({ target: outcomes.gameId, set: o })
      .run();
  },
  allOutcomes(): Outcome[] {
    return db.select().from(outcomes).all();
  },

  // ── slates ──
  upsertSlate(s: InsertSlate): Slate {
    return db.insert(slates).values(s).returning().get();
  },

  // ── hit rate cache ──
  hitRates(sport: string): HitRateCacheRow[] {
    return db.select().from(hitRateCache).where(eq(hitRateCache.sport, sport)).all();
  },
  upsertHitRate(h: InsertHitRateCache): void {
    db.insert(hitRateCache).values(h).run();
  },
  clearHitRates(sport: string): void {
    db.delete(hitRateCache).where(eq(hitRateCache.sport, sport)).run();
  },
};

export type Storage = typeof storage;
export { gte };
