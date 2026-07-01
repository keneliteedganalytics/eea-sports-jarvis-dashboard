// Player-props adapter — The Odds API per-event endpoint:
//   GET /v4/sports/{sportKey}/events/{eventId}/odds?regions=us&markets={list}
// Headline markets only (one consensus line/price per player+market), cached per
// game for 5 minutes. Returns [] when ODDS_API_KEY is unset.

import { getJson } from "../adapters/http";
import { TRUSTED_BOOKS, PROPS_ONLY_BOOKS } from "../core/odds";

const BASE = "https://api.the-odds-api.com/v4/sports";
const CACHE_TTL_MS = 5 * 60 * 1000;

export const HEADLINE_MARKETS: Record<string, string[]> = {
  mlb: ["batter_home_runs", "batter_hits", "batter_total_bases", "pitcher_strikeouts"],
  nhl: ["player_goal_scorer_anytime", "player_shots_on_goal", "player_points"],
  nba: ["player_points", "player_rebounds", "player_assists", "player_threes"],
};

const SPORT_KEY: Record<string, string> = {
  mlb: "baseball_mlb",
  nhl: "icehockey_nhl",
  nba: "basketball_nba",
};

export interface RawProp {
  eventId: string;
  market: string;
  playerName: string;
  line: number;
  overPrice: number | null;
  underPrice: number | null;
  book: string;
}

interface RawOutcome {
  name: string; // "Over" / "Under" (or "Yes"/player for binary markets)
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
  markets: RawMarket[];
}
interface RawEventOdds {
  id: string;
  bookmakers: RawBookmaker[];
}

interface CacheEntry {
  ts: number;
  props: RawProp[];
}
const cache = new Map<string, CacheEntry>();

export function hasOddsKey(): boolean {
  return Boolean(process.env.ODDS_API_KEY);
}

// Fetch headline player props for a single event. Picks the first trusted book
// that posts each player+market (consensus across books is overkill for v1).
export async function fetchEventProps(sport: string, eventId: string): Promise<RawProp[]> {
  if (!hasOddsKey()) return [];
  const sportKey = SPORT_KEY[sport];
  const markets = HEADLINE_MARKETS[sport];
  if (!sportKey || !markets) return [];

  const cacheKey = `${sport}:${eventId}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.props;

  const res = await getJson<RawEventOdds>(`${BASE}/${sportKey}/events/${eventId}/odds`, {
    apiKey: process.env.ODDS_API_KEY,
    regions: "us",
    markets: markets.join(","),
    oddsFormat: "american",
  });
  if (!res.ok || !res.data?.bookmakers) {
    cache.set(cacheKey, { ts: Date.now(), props: [] });
    return [];
  }

  // Props surface: real sportsbooks + the DFS/props operators (PROPS_ONLY_BOOKS).
  const trusted = new Set([...TRUSTED_BOOKS, ...PROPS_ONLY_BOOKS]);
  // key = `${player}|${market}` → {over,under,line,book}
  const byPlayer = new Map<string, RawProp>();
  for (const bm of res.data.bookmakers) {
    if (!trusted.has(bm.key)) continue;
    for (const mk of bm.markets ?? []) {
      if (!markets.includes(mk.key)) continue;
      for (const o of mk.outcomes ?? []) {
        const player = o.description ?? o.name;
        if (!player) continue;
        const k = `${player}|${mk.key}`;
        const existing = byPlayer.get(k) ?? {
          eventId,
          market: mk.key,
          playerName: player,
          line: o.point ?? 0.5,
          overPrice: null,
          underPrice: null,
          book: bm.key,
        };
        const isUnder = /under/i.test(o.name);
        const isOver = /over|yes/i.test(o.name);
        if (isUnder) existing.underPrice = o.price;
        else if (isOver) existing.overPrice = o.price;
        else existing.overPrice = o.price; // anytime-scorer style (single price)
        if (o.point !== undefined) existing.line = o.point;
        byPlayer.set(k, existing);
      }
    }
  }

  const props = [...byPlayer.values()];
  cache.set(cacheKey, { ts: Date.now(), props });
  return props;
}

export function _clearPropsCache(): void {
  cache.clear();
}
