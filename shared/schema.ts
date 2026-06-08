import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ── games ────────────────────────────────────────────────────────
export const games = sqliteTable("games", {
  id: text("id").primaryKey(),
  sport: text("sport").notNull(),
  homeTeam: text("home_team").notNull(),
  awayTeam: text("away_team").notNull(),
  startTimeUtc: text("start_time_utc").notNull(),
  status: text("status").notNull().default("scheduled"),
  slateDateEt: text("slate_date_et").notNull(),
  // Soccer fields (v3) — nullable on all other sports
  leagueName: text("league_name"),
  leagueId: integer("league_id"),
  isFriendly: integer("is_friendly", { mode: "boolean" }),
});

// ── odds_snapshots ───────────────────────────────────────────────
export const oddsSnapshots = sqliteTable("odds_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  gameId: text("game_id").notNull(),
  book: text("book").notNull(),
  side: text("side").notNull(),
  americanPrice: integer("american_price").notNull(),
  ts: text("ts").notNull().default(sql`CURRENT_TIMESTAMP`),
  isOpener: integer("is_opener", { mode: "boolean" }).notNull().default(false),
});

// ── predictions ──────────────────────────────────────────────────
export const predictions = sqliteTable("predictions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  gameId: text("game_id").notNull(),
  formulaVersion: text("formula_version").notNull(),
  side: text("side").notNull(),
  modelProb: real("model_prob").notNull(),
  marketProb: real("market_prob").notNull(),
  edgePp: real("edge_pp").notNull(),
  evPerDollar: real("ev_per_dollar").notNull(),
  kellyUnits: real("kelly_units").notNull(),
  kellyDollars: real("kelly_dollars").notNull(),
  tier: text("tier").notNull(),
  confidence: integer("confidence").notNull(),
  rawFeaturesJson: text("raw_features_json").notNull().default("{}"),
  // EEA v2.5 fields (SPEC §12).
  alignmentSignalRaw: real("alignment_signal_raw"),
  subSampleWarning: integer("sub_sample_warning", { mode: "boolean" }).notNull().default(false),
  halfCut: integer("half_cut", { mode: "boolean" }).notNull().default(false),
  phantomEdge: integer("phantom_edge", { mode: "boolean" }).notNull().default(false),
  trimmed: integer("trimmed", { mode: "boolean" }).notNull().default(false),
  topPlay: integer("top_play", { mode: "boolean" }).notNull().default(false),
  ts: text("ts").notNull().default(sql`CURRENT_TIMESTAMP`),
  // Soccer: 3-way draw probability (null for 2-way sports)
  drawProb: real("draw_prob"),
});

// ── outcomes ─────────────────────────────────────────────────────
export const outcomes = sqliteTable("outcomes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  gameId: text("game_id").notNull().unique(),
  finalHomeScore: integer("final_home_score"),
  finalAwayScore: integer("final_away_score"),
  winnerSide: text("winner_side"),
  closedAt: text("closed_at"),
  // Soccer: true when the game ended as a draw
  isDraw: integer("is_draw", { mode: "boolean" }),
});

// ── slates ───────────────────────────────────────────────────────
export const slates = sqliteTable("slates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sport: text("sport").notNull(),
  dateEt: text("date_et").notNull(),
  pickCount: integer("pick_count").notNull().default(0),
  lockedAt: text("locked_at"),
});

// ── formula_versions ─────────────────────────────────────────────
export const formulaVersions = sqliteTable("formula_versions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sport: text("sport").notNull(),
  version: text("version").notNull(),
  paramsJson: text("params_json").notNull().default("{}"),
  effectiveFrom: text("effective_from").notNull(),
});

// ── audio_cache (ported from horse-jarvis) ───────────────────────
export const audioCache = sqliteTable("audio_cache", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  hash: text("hash").notNull().unique(),
  text: text("text").notNull(),
  voiceId: text("voice_id").notNull(),
  model: text("model").notNull(),
  mp3Path: text("mp3_path").notNull(),
  ts: text("ts").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// ── hit_rate_cache ───────────────────────────────────────────────
export const hitRateCache = sqliteTable("hit_rate_cache", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sport: text("sport").notNull(),
  tier: text("tier").notNull(),
  windowDays: integer("window_days").notNull(),
  wins: integer("wins").notNull().default(0),
  losses: integer("losses").notNull().default(0),
  pushes: integer("pushes").notNull().default(0),
  unitsWon: real("units_won").notNull().default(0),
  refreshedAt: text("refreshed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// ── props ────────────────────────────────────────────────────────
export const props = sqliteTable("props", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  gameId: text("game_id").notNull(),
  sport: text("sport").notNull(),
  playerName: text("player_name").notNull(),
  market: text("market").notNull(),
  line: real("line").notNull(),
  overPrice: integer("over_price"),
  underPrice: integer("under_price"),
  book: text("book").notNull(),
  modelProb: real("model_prob"),
  edgePp: real("edge_pp"),
  tier: text("tier"),
  side: text("side"),
  uncalibrated: integer("uncalibrated", { mode: "boolean" }).notNull().default(true),
  ts: text("ts").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// ── insert schemas ───────────────────────────────────────────────
export const insertGameSchema = createInsertSchema(games);
export const insertOddsSnapshotSchema = createInsertSchema(oddsSnapshots).omit({ id: true });
export const insertPredictionSchema = createInsertSchema(predictions).omit({ id: true });
export const insertOutcomeSchema = createInsertSchema(outcomes).omit({ id: true });
export const insertSlateSchema = createInsertSchema(slates).omit({ id: true });
export const insertFormulaVersionSchema = createInsertSchema(formulaVersions).omit({ id: true });
export const insertAudioCacheSchema = createInsertSchema(audioCache).omit({ id: true });
export const insertHitRateCacheSchema = createInsertSchema(hitRateCache).omit({ id: true });

// ── inferred types ───────────────────────────────────────────────
export type Game = typeof games.$inferSelect;
export type InsertGame = z.infer<typeof insertGameSchema>;
export type OddsSnapshot = typeof oddsSnapshots.$inferSelect;
export type InsertOddsSnapshot = z.infer<typeof insertOddsSnapshotSchema>;
export type Prediction = typeof predictions.$inferSelect;
export type InsertPrediction = z.infer<typeof insertPredictionSchema>;
export type Outcome = typeof outcomes.$inferSelect;
export type InsertOutcome = z.infer<typeof insertOutcomeSchema>;
export type Slate = typeof slates.$inferSelect;
export type InsertSlate = z.infer<typeof insertSlateSchema>;
export type FormulaVersion = typeof formulaVersions.$inferSelect;
export type InsertFormulaVersion = z.infer<typeof insertFormulaVersionSchema>;
export type AudioCacheRow = typeof audioCache.$inferSelect;
export type InsertAudioCache = z.infer<typeof insertAudioCacheSchema>;
export type HitRateCacheRow = typeof hitRateCache.$inferSelect;
export type InsertHitRateCache = z.infer<typeof insertHitRateCacheSchema>;
