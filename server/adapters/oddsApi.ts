// The Odds API adapter — MLB moneyline (h2h) odds across US books.
// https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/
// Returns [] when ODDS_API_KEY is unset so the app boots without credentials.

import { getJson } from "./http";
import { nameToAbbr } from "../sports/mlb/teams";
import { TRUSTED_BOOKS } from "../core/odds";

const BASE = "https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/";

export interface BookPrice {
  book: string;
  homePrice: number | null;
  awayPrice: number | null;
}

export interface OddsEvent {
  eventId: string;
  startIso: string;
  homeTeam: string; // tri-code
  awayTeam: string;
  homeTeamFull: string;
  awayTeamFull: string;
  books: BookPrice[];
}

interface RawOutcome {
  name: string;
  price: number;
}
interface RawMarket {
  key: string;
  outcomes: RawOutcome[];
}
interface RawBookmaker {
  key: string;
  title: string;
  markets: RawMarket[];
}
interface RawEvent {
  id: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: RawBookmaker[];
}

export function hasOddsKey(): boolean {
  return Boolean(process.env.ODDS_API_KEY);
}

export async function fetchOdds(): Promise<OddsEvent[]> {
  if (!hasOddsKey()) return [];

  const res = await getJson<RawEvent[]>(BASE, {
    apiKey: process.env.ODDS_API_KEY,
    regions: "us",
    markets: "h2h",
    oddsFormat: "american",
  });
  if (!res.ok || !Array.isArray(res.data)) return [];

  const trusted = new Set(TRUSTED_BOOKS);
  return res.data.map((ev) => {
    const books: BookPrice[] = [];
    for (const bm of ev.bookmakers ?? []) {
      if (!trusted.has(bm.key)) continue;
      const h2h = bm.markets?.find((m) => m.key === "h2h");
      if (!h2h) continue;
      const home = h2h.outcomes.find((o) => o.name === ev.home_team)?.price ?? null;
      const away = h2h.outcomes.find((o) => o.name === ev.away_team)?.price ?? null;
      books.push({ book: bm.key, homePrice: home, awayPrice: away });
    }
    return {
      eventId: ev.id,
      startIso: ev.commence_time,
      homeTeam: nameToAbbr(ev.home_team),
      awayTeam: nameToAbbr(ev.away_team),
      homeTeamFull: ev.home_team,
      awayTeamFull: ev.away_team,
      books,
    };
  });
}
