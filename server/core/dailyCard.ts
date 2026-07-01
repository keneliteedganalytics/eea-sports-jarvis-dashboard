// v6.14.0 — daily card lock. Once per operating day (at the 6:00 AM ET snapshot)
// we freeze 3–5 of the day's best PLAY picks plus any correlation-aware parlays
// into the `daily_cards` table in data.db. Subsequent builds NEVER overwrite a
// locked row — the home page reads the frozen card so odds/tiers don't drift
// mid-day. Selection is pure + deterministic (selectDailyCard) so it unit-tests
// cleanly; persistence is a thin wrapper around it.

import Database from "better-sqlite3";
import type { BuiltPick } from "../sports/mlb/picksEngine";
import type { Verdict } from "./types";
import { buildParlays, type Parlay } from "../sports/mlb/parlays";
import { getOperatingDay } from "../sports/mlb/operatingDay";

// Card sizing. We aim for MIN..MAX picks; the edge floor starts at EDGE and is
// lowered by STEP toward FLOOR_MIN until we have at least MIN picks.
export const CARD_MIN_PICKS = 3;
export const CARD_MAX_PICKS = 5;
export const CARD_EDGE_START_PP = 4.0; // EDGE tier edge
export const CARD_EDGE_FLOOR_PP = 2.5; // RECON tier edge — don't go below this
export const CARD_EDGE_STEP_PP = 0.5;
// Two candidates whose edges are within this band are treated as "tied" for the
// purpose of the market-diversity tie-break.
export const CARD_DIVERSITY_BAND_PP = 1.0;

export type CardMarket = "ML" | "Runline" | "Total";

export interface CardPick {
  gameId: string;
  gameDate: string;
  gameTimeEt: string;
  gameStartIso: string | null;
  matchup: string;
  homeTeam: string;
  awayTeam: string;
  market: CardMarket;
  selection: string; // human label, e.g. "LAD ML", "TB -1.5", "Over 8.5"
  pickTeam: string | null;
  line: number | null;
  priceAmerican: number | null;
  fairLine: number | null;
  winProb: number | null;
  edgePp: number | null;
  tier: Verdict;
  units: number;
  book: string | null;
  // Live/grade placeholders — filled at serve time from the graded book.
  gradeResult?: "W" | "L" | "P" | null;
  liveHomeScore?: number | null;
  liveAwayScore?: number | null;
}

export interface DailyCard {
  cardDate: string;
  lockedAt: string | null;
  picks: CardPick[];
  parlays: Parlay[];
  bankrollAtLock: number | null;
  passReason: string | null;
}

// ---- pure selection -------------------------------------------------------

// Map a BuiltPick's chosen market kind to the card's market vocabulary.
function marketLabel(kind: "ml" | "spread" | "total"): CardMarket {
  if (kind === "ml") return "ML";
  if (kind === "spread") return "Runline";
  return "Total";
}

// Build the single best card candidate for one game: the highest-edge available
// market (ml / spread / total) on that pick. Returns null when nothing is
// actionable (no available market with a positive edge).
function bestCandidate(p: BuiltPick): CardPick | null {
  const kinds: Array<"ml" | "spread" | "total"> = ["ml", "spread", "total"];
  let best: { kind: "ml" | "spread" | "total"; edge: number } | null = null;
  for (const kind of kinds) {
    const m = p.markets[kind];
    if (!m || !m.available || m.priceAmerican === null) continue;
    const edge = m.edgePp ?? -Infinity;
    if (best === null || edge > best.edge) best = { kind, edge };
  }
  if (best === null) return null;

  const m = p.markets[best.kind];
  return {
    gameId: p.gameId,
    gameDate: p.gameDate,
    gameTimeEt: p.gameTimeEt,
    gameStartIso: p.gameStartIso ?? null,
    matchup: p.matchup,
    homeTeam: p.homeTeam,
    awayTeam: p.awayTeam,
    market: marketLabel(best.kind),
    selection: m.pick ?? "",
    pickTeam: p.pickTeam ?? null,
    line: m.line,
    priceAmerican: m.priceAmerican,
    fairLine: m.fairLine,
    winProb: p.pickWinProb,
    edgePp: m.edgePp,
    tier: m.tier,
    units: m.units,
    book: m.book,
  };
}

// Market-diversity tie-break: within a run of candidates whose edges fall inside
// CARD_DIVERSITY_BAND_PP, nudge picks that repeat an already-used market to the
// back so the card mixes ML / Runline / Total when edges are effectively tied.
function diversify(sorted: CardPick[]): CardPick[] {
  const out: CardPick[] = [];
  const remaining = [...sorted];
  const usedMarkets = new Set<CardMarket>();
  while (remaining.length > 0) {
    const head = remaining[0];
    // Consider the tie-band starting at the head.
    let pickIdx = 0;
    for (let i = 0; i < remaining.length; i++) {
      const withinBand =
        (head.edgePp ?? 0) - (remaining[i].edgePp ?? 0) <= CARD_DIVERSITY_BAND_PP;
      if (!withinBand) break;
      if (!usedMarkets.has(remaining[i].market)) {
        pickIdx = i;
        break;
      }
    }
    const chosen = remaining.splice(pickIdx, 1)[0];
    usedMarkets.add(chosen.market);
    out.push(chosen);
  }
  return out;
}

// Pure card selection from a full slate of built picks. Returns the chosen
// CardPicks (0..MAX) plus a passReason when the card is empty.
export function selectDailyCard(picks: BuiltPick[]): {
  picks: CardPick[];
  passReason: string | null;
} {
  // One candidate per game (best market), PLAY verdicts only, deduped by gameId
  // keeping the highest-edge candidate.
  const byGame = new Map<string, CardPick>();
  for (const p of picks) {
    if (p.verdict !== "PLAY") continue;
    const cand = bestCandidate(p);
    if (!cand) continue;
    const existing = byGame.get(cand.gameId);
    if (!existing || (cand.edgePp ?? -Infinity) > (existing.edgePp ?? -Infinity)) {
      byGame.set(cand.gameId, cand);
    }
  }

  const candidates = [...byGame.values()].sort(
    (a, b) => (b.edgePp ?? -Infinity) - (a.edgePp ?? -Infinity),
  );
  if (candidates.length === 0) {
    return { picks: [], passReason: "no_qualifying_plays" };
  }

  // Lower the edge floor by STEP until we clear MIN picks (or hit the floor).
  let floor = CARD_EDGE_START_PP;
  let chosen = candidates.filter((c) => (c.edgePp ?? -Infinity) >= floor);
  while (chosen.length < CARD_MIN_PICKS && floor - CARD_EDGE_STEP_PP >= CARD_EDGE_FLOOR_PP) {
    floor -= CARD_EDGE_STEP_PP;
    chosen = candidates.filter((c) => (c.edgePp ?? -Infinity) >= floor);
  }
  // If even the lowest floor can't reach MIN, surface whatever cleared it (data
  // quality, not floor, is the limiter). Never fabricate picks below RECON edge.
  if (chosen.length === 0) {
    chosen = candidates.filter((c) => (c.edgePp ?? -Infinity) >= CARD_EDGE_FLOOR_PP);
  }
  if (chosen.length === 0) {
    return { picks: [], passReason: "no_qualifying_plays" };
  }

  const diversified = diversify(chosen).slice(0, CARD_MAX_PICKS);
  return { picks: diversified, passReason: null };
}

// ---- persistence ----------------------------------------------------------

let _db: Database.Database | null = null;
function db(): Database.Database {
  if (_db) return _db;
  _db = new Database("data.db");
  _db.pragma("journal_mode = WAL");
  initDailyCardSchema(_db);
  return _db;
}

export function initDailyCardSchema(conn: Database.Database = db()): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS daily_cards (
      card_date TEXT PRIMARY KEY,
      locked_at TEXT NOT NULL,
      picks_json TEXT NOT NULL DEFAULT '[]',
      parlays_json TEXT NOT NULL DEFAULT '[]',
      bankroll_at_lock REAL,
      pass_reason TEXT
    );
  `);
}

function rowToCard(row: {
  card_date: string;
  locked_at: string;
  picks_json: string;
  parlays_json: string;
  bankroll_at_lock: number | null;
  pass_reason: string | null;
}): DailyCard {
  return {
    cardDate: row.card_date,
    lockedAt: row.locked_at,
    picks: JSON.parse(row.picks_json) as CardPick[],
    parlays: JSON.parse(row.parlays_json) as Parlay[],
    bankrollAtLock: row.bankroll_at_lock,
    passReason: row.pass_reason,
  };
}

// Read a locked card by operating-day date (YYYY-MM-DD). null when unlocked.
export function getCard(cardDate: string): DailyCard | null {
  const row = db()
    .prepare("SELECT * FROM daily_cards WHERE card_date = ?")
    .get(cardDate) as Parameters<typeof rowToCard>[0] | undefined;
  return row ? rowToCard(row) : null;
}

// Today's locked card (operating-day aware), or null when not yet locked.
export function getTodayCard(now: Date = new Date()): DailyCard | null {
  return getCard(getOperatingDay(now));
}

// Lock the card for a given date from a slate's built picks. Idempotent: if a
// row already exists it is returned untouched (the card is frozen for the day).
// Pass force=true (admin regenerate) to overwrite the existing row.
export function lockDailyCard(
  cardDate: string,
  slatePicks: BuiltPick[],
  bankroll: number | null,
  opts: { force?: boolean } = {},
): DailyCard {
  const conn = db();
  const existing = getCard(cardDate);
  if (existing && !opts.force) return existing;

  const { picks, passReason } = selectDailyCard(slatePicks);
  const parlays = passReason ? [] : buildParlays(picks);
  const lockedAt = new Date().toISOString();

  conn
    .prepare(
      `INSERT INTO daily_cards (card_date, locked_at, picks_json, parlays_json, bankroll_at_lock, pass_reason)
       VALUES (@card_date, @locked_at, @picks_json, @parlays_json, @bankroll_at_lock, @pass_reason)
       ON CONFLICT(card_date) DO UPDATE SET
         locked_at = excluded.locked_at,
         picks_json = excluded.picks_json,
         parlays_json = excluded.parlays_json,
         bankroll_at_lock = excluded.bankroll_at_lock,
         pass_reason = excluded.pass_reason`,
    )
    .run({
      card_date: cardDate,
      locked_at: lockedAt,
      picks_json: JSON.stringify(picks),
      parlays_json: JSON.stringify(parlays),
      bankroll_at_lock: bankroll,
      pass_reason: passReason,
    });

  return {
    cardDate,
    lockedAt,
    picks,
    parlays,
    bankrollAtLock: bankroll,
    passReason,
  };
}

// Test hook — reset the module-level connection (used by unit tests that point
// data.db at a temp file via cwd).
export function _resetDailyCardDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
