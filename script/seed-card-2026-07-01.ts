// v6.14.1 — one-shot seed for the corrected 2026-07-01 daily card.
//
// Ken's override after the runline probability bug surfaced on the 6:00 AM lock:
//   1) MIN ML          +119   1.5u
//   2) TB/KC U10.5     (price from latest snapshot)   1.5u
//   3) STL/ATL O9      (price from latest snapshot)   1.0u
//
// Provenance rules (dossier-background-screen / final-adjudicator):
//   • No fabricated numeric fields. modelProb, edgePp, fairLine are pulled from
//     the latest matching row in `predictions` for each gameId+side. If a row
//     is missing we leave the field null rather than invent one — the card
//     still renders (see dailyCard.ts CardPick — nullable numerics).
//   • priceAmerican and book pull from the newest `odds_snapshots` row for the
//     matching (game_id, side). MIN ML uses the caller-supplied +119 as the
//     locked price per Ken's explicit override.
//   • Overwrites the existing 2026-07-01 row via ON CONFLICT — same idempotent
//     path lockDailyCard uses when force=true.
//
// Run:  npx tsx script/seed-card-2026-07-01.ts
// Env:  reads ./data.db in cwd (same as the running server).

import Database from "better-sqlite3";
import { initDailyCardSchema } from "../server/core/dailyCard";
import type { CardPick } from "../server/core/dailyCard";
import type { Parlay } from "../server/sports/mlb/parlays";

const CARD_DATE = "2026-07-01";

// Ken's three overrides. Team codes match the abbreviations stored in
// games.home_team / games.away_team (see data.ts eventId mapping).
interface Override {
  homeTeam: string;
  awayTeam: string;
  market: "ML" | "Runline" | "Total";
  side: string;              // predictions.side + odds_snapshots.side literal
  selectionLabel: string;
  pickTeam: string | null;
  line: number | null;
  fallbackPrice: number | null;   // used only when no odds_snapshots row exists
  units: number;
}

const OVERRIDES: Override[] = [
  {
    homeTeam: "MIN",           // caller specified "MIN ML" without opponent —
    awayTeam: "MIN",           //   lookup below matches EITHER slot
    market: "ML",
    side: "MIN",
    selectionLabel: "MIN ML (+119)",
    pickTeam: "MIN",
    line: null,
    fallbackPrice: 119,
    units: 1.5,
  },
  {
    homeTeam: "KC",
    awayTeam: "TB",
    market: "Total",
    side: "under",
    selectionLabel: "Under 10.5",
    pickTeam: null,
    line: 10.5,
    fallbackPrice: -110,
    units: 1.5,
  },
  {
    homeTeam: "ATL",
    awayTeam: "STL",
    market: "Total",
    side: "over",
    selectionLabel: "Over 9",
    pickTeam: null,
    line: 9,
    fallbackPrice: -110,
    units: 1.0,
  },
];

interface GameRow {
  id: string;
  home_team: string;
  away_team: string;
  start_time_utc: string;
  slate_date_et: string;
}

interface PredictionRow {
  model_prob: number | null;
  edge_pp: number | null;
  tier: string | null;
}

interface OddsRow {
  american_price: number | null;
  book: string | null;
}

function findGame(db: Database.Database, o: Override): GameRow | null {
  // For the MIN ML override we don't know the opponent — match slate_date + MIN
  // in either home or away slot.
  if (o.homeTeam === o.awayTeam) {
    const row = db
      .prepare(
        `SELECT id, home_team, away_team, start_time_utc, slate_date_et
         FROM games
         WHERE slate_date_et = ? AND (home_team = ? OR away_team = ?)
         ORDER BY start_time_utc ASC
         LIMIT 1`,
      )
      .get(CARD_DATE, o.homeTeam, o.homeTeam) as GameRow | undefined;
    return row ?? null;
  }
  const row = db
    .prepare(
      `SELECT id, home_team, away_team, start_time_utc, slate_date_et
       FROM games
       WHERE slate_date_et = ?
         AND ((home_team = ? AND away_team = ?) OR (home_team = ? AND away_team = ?))
       LIMIT 1`,
    )
    .get(CARD_DATE, o.homeTeam, o.awayTeam, o.awayTeam, o.homeTeam) as
    | GameRow
    | undefined;
  return row ?? null;
}

function latestPrediction(
  db: Database.Database,
  gameId: string,
  side: string,
): PredictionRow {
  const row = db
    .prepare(
      `SELECT model_prob, edge_pp, tier
       FROM predictions
       WHERE game_id = ? AND side = ?
       ORDER BY ts DESC
       LIMIT 1`,
    )
    .get(gameId, side) as PredictionRow | undefined;
  return row ?? { model_prob: null, edge_pp: null, tier: null };
}

function latestOdds(
  db: Database.Database,
  gameId: string,
  side: string,
): OddsRow {
  const row = db
    .prepare(
      `SELECT american_price, book
       FROM odds_snapshots
       WHERE game_id = ? AND side = ?
       ORDER BY ts DESC
       LIMIT 1`,
    )
    .get(gameId, side) as OddsRow | undefined;
  return row ?? { american_price: null, book: null };
}

function fairLineFromProb(p: number | null): number | null {
  if (p === null || p <= 0 || p >= 1) return null;
  return p >= 0.5 ? -Math.round((p / (1 - p)) * 100) : Math.round(((1 - p) / p) * 100);
}

function tierFromEdge(edgePp: number | null, fallback: string | null): CardPick["tier"] {
  if (edgePp === null) return (fallback as CardPick["tier"]) ?? "RECON";
  if (edgePp >= 5) return "SNIPER";
  if (edgePp >= 4) return "EDGE";
  return "RECON";
}

function toIsoEt(startUtc: string): string {
  const d = new Date(startUtc);
  return d.toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function build(): CardPick[] {
  const db = new Database("data.db");
  db.pragma("journal_mode = WAL");
  initDailyCardSchema(db);

  const out: CardPick[] = [];
  for (const o of OVERRIDES) {
    const game = findGame(db, o);
    if (!game) {
      console.warn(
        `[seed-card] SKIP ${o.homeTeam}/${o.awayTeam} ${o.market} — no games row for ${CARD_DATE}`,
      );
      continue;
    }
    const pred = latestPrediction(db, game.id, o.side);
    const odds = latestOdds(db, game.id, o.side);

    const priceAmerican =
      // MIN ML uses caller-supplied +119 lock per Ken's override.
      o.homeTeam === "MIN" && o.market === "ML"
        ? o.fallbackPrice
        : odds.american_price ?? o.fallbackPrice;

    const pick: CardPick = {
      gameId: game.id,
      gameDate: CARD_DATE,
      gameTimeEt: toIsoEt(game.start_time_utc),
      gameStartIso: game.start_time_utc,
      matchup: `${game.away_team} @ ${game.home_team}`,
      homeTeam: game.home_team,
      awayTeam: game.away_team,
      market: o.market,
      selection: o.selectionLabel,
      pickTeam: o.pickTeam,
      line: o.line,
      priceAmerican,
      fairLine: fairLineFromProb(pred.model_prob),
      winProb: pred.model_prob,
      edgePp: pred.edge_pp,
      tier: tierFromEdge(pred.edge_pp, pred.tier),
      units: o.units,
      book: odds.book,
    };
    out.push(pick);
    console.log(
      `[seed-card] ${o.selectionLabel} — game=${game.id} price=${priceAmerican} ` +
        `modelProb=${pred.model_prob ?? "n/a"} edgePp=${pred.edge_pp ?? "n/a"}`,
    );
  }

  db.close();
  return out;
}

function upsert(picks: CardPick[]): void {
  const db = new Database("data.db");
  db.pragma("journal_mode = WAL");
  initDailyCardSchema(db);

  const parlays: Parlay[] = []; // manual override — no auto-parlays for override day
  const lockedAt = new Date().toISOString();

  db.prepare(
    `INSERT INTO daily_cards (card_date, locked_at, picks_json, parlays_json, bankroll_at_lock, pass_reason)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(card_date) DO UPDATE SET
       locked_at = excluded.locked_at,
       picks_json = excluded.picks_json,
       parlays_json = excluded.parlays_json,
       pass_reason = excluded.pass_reason`,
  ).run(
    CARD_DATE,
    lockedAt,
    JSON.stringify(picks),
    JSON.stringify(parlays),
    null,
    null,
  );

  console.log(`[seed-card] upserted ${picks.length} picks into daily_cards for ${CARD_DATE}`);
  db.close();
}

const picks = build();
if (picks.length === 0) {
  console.error("[seed-card] refusing to write empty card — no matches in games table");
  process.exit(1);
}
upsert(picks);
