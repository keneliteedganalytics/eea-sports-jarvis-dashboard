// MLB prop ingestion from The Odds API per-event endpoint:
//   GET /v4/sports/baseball_mlb/events/{eventId}/odds?regions=us&markets={market}&apiKey=…
//
// Pulls every US book that posts each market and stores ONE ROW PER BOOK per
// market per player in prop_offers, so the pick builder can shop the best price.
// Best-effort: no key, or any upstream failure, yields zero offers (the builder
// then produces no props — no fabricated data).

import { getJson } from "../../adapters/http";
import {
  upsertPropOffer,
  clearPropOffersForDate,
  propOffersForDate,
  type PropOfferRow,
} from "../../gradedBook";
import { BATTER_MARKETS, PITCHER_MARKETS } from "./simulate";

const BASE = "https://api.the-odds-api.com/v4/sports";
const SPORT_KEY = "baseball_mlb";

// All MLB markets the engine simulates (spec §1).
export const MLB_PROP_MARKETS: string[] = [...BATTER_MARKETS, ...PITCHER_MARKETS];

export function hasOddsKey(): boolean {
  return Boolean(process.env.ODDS_API_KEY && process.env.ODDS_API_KEY.trim());
}

interface RawOutcome {
  name: string; // "Over" / "Under"
  description?: string; // player name
  price: number;
  point?: number;
}
interface RawMarket {
  key: string;
  outcomes: RawOutcome[];
}
interface RawBookmaker {
  key: string;
  title?: string;
  markets?: RawMarket[];
}
interface RawEventOdds {
  id: string;
  home_team?: string;
  away_team?: string;
  commence_time?: string;
  bookmakers?: RawBookmaker[];
}

// List MLB events for a date window so we can enumerate eventIds to pull props
// for. The Odds API events endpoint returns upcoming events; we filter by the
// requested operating date (commence_time's UTC date, best-effort).
interface RawEvent {
  id: string;
  commence_time: string;
  home_team: string;
  away_team: string;
}

export interface MlbEvent {
  eventId: string;
  commenceIso: string;
  homeTeam: string;
  awayTeam: string;
}

export async function fetchMlbEvents(date: string): Promise<MlbEvent[]> {
  if (!hasOddsKey()) return [];
  const res = await getJson<RawEvent[]>(`${BASE}/${SPORT_KEY}/events`, {
    apiKey: process.env.ODDS_API_KEY,
  });
  if (!res.ok || !Array.isArray(res.data)) return [];
  return res.data
    .filter((e) => typeof e.commence_time === "string" && e.commence_time.slice(0, 10) === date)
    .map((e) => ({
      eventId: e.id,
      commenceIso: e.commence_time,
      homeTeam: e.home_team,
      awayTeam: e.away_team,
    }));
}

// Parse a raw event-odds payload into per-book offer rows. Exported for tests so
// the parsing is verifiable without a live key. One row per (book, market,
// player) — Over and Under prices collapse onto the same row.
export function parseEventOdds(
  raw: RawEventOdds,
  date: string,
): Omit<PropOfferRow, "fetched_at">[] {
  const out: Omit<PropOfferRow, "fetched_at">[] = [];
  // key: `${book}|${market}|${player}` → row under construction
  const byKey = new Map<string, Omit<PropOfferRow, "fetched_at">>();
  for (const bm of raw.bookmakers ?? []) {
    for (const mk of bm.markets ?? []) {
      if (!MLB_PROP_MARKETS.includes(mk.key)) continue;
      for (const o of mk.outcomes ?? []) {
        const player = o.description;
        if (!player) continue;
        const k = `${bm.key}|${mk.key}|${player}`;
        const existing =
          byKey.get(k) ??
          ({
            event_id: raw.id,
            sport: "mlb",
            game_date: date,
            player_name: player,
            player_id: null,
            team: null,
            event_home: raw.home_team ?? null,
            event_away: raw.away_team ?? null,
            market: mk.key,
            line: o.point ?? 0.5,
            over_price: null,
            under_price: null,
            book: bm.key,
          } as Omit<PropOfferRow, "fetched_at">);
        if (/under/i.test(o.name)) existing.under_price = o.price;
        else if (/over/i.test(o.name)) existing.over_price = o.price;
        if (o.point !== undefined) existing.line = o.point;
        byKey.set(k, existing);
      }
    }
  }
  for (const v of byKey.values()) out.push(v);
  return out;
}

// Fetch + store props for a single event across all books. Markets are requested
// in one call (comma-joined) to conserve the Odds API quota.
export async function ingestEventProps(eventId: string, date: string): Promise<number> {
  if (!hasOddsKey()) return 0;
  const res = await getJson<RawEventOdds>(`${BASE}/${SPORT_KEY}/events/${eventId}/odds`, {
    apiKey: process.env.ODDS_API_KEY,
    regions: "us",
    markets: MLB_PROP_MARKETS.join(","),
    oddsFormat: "american",
  });
  if (!res.ok || !res.data) return 0;
  const rows = parseEventOdds(res.data, date);
  for (const r of rows) {
    upsertPropOffer({
      event_id: r.event_id,
      sport: r.sport,
      game_date: r.game_date,
      player_name: r.player_name,
      player_id: r.player_id,
      team: r.team,
      event_home: r.event_home,
      event_away: r.event_away,
      market: r.market,
      line: r.line,
      over_price: r.over_price,
      under_price: r.under_price,
      book: r.book,
    });
  }
  return rows.length;
}

export interface IngestSummary {
  date: string;
  events: number;
  offers: number;
}

// Ingest tomorrow's full MLB prop slate. Clears the date's prior offers first so
// stale quotes don't linger, then pulls every event. Returns a summary.
export async function ingestMlbPropsForDate(date: string): Promise<IngestSummary> {
  if (!hasOddsKey()) return { date, events: 0, offers: 0 };
  clearPropOffersForDate(date);
  const events = await fetchMlbEvents(date);
  let offers = 0;
  for (const ev of events) {
    offers += await ingestEventProps(ev.eventId, date).catch(() => 0);
  }
  return { date, events: events.length, offers };
}

// Read-back helper used by the builder + tests.
export function offersForDate(date: string): PropOfferRow[] {
  return propOffersForDate(date, "mlb");
}
