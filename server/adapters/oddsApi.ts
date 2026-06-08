// The Odds API adapter — moneyline (h2h) + spreads + totals across US books.
// https://api.the-odds-api.com/v4/sports/{sportKey}/odds/
// Returns [] when ODDS_API_KEY is unset so the app boots without credentials.

import { getJson } from "./http";
import { nameToAbbr } from "../sports/mlb/teams";
import { TRUSTED_BOOKS } from "../core/odds";

const BASE = "https://api.the-odds-api.com/v4/sports";

export interface BookPrice {
  book: string;
  homePrice: number | null;
  awayPrice: number | null;
}

// Consensus spread/total derived from the median across trusted books.
export interface SpreadConsensus {
  homeLine: number | null; // e.g. -1.5
  homePrice: number | null;
  awayLine: number | null; // e.g. +1.5
  awayPrice: number | null;
  book: string | null;
}

export interface TotalConsensus {
  line: number | null; // e.g. 8.5
  overPrice: number | null;
  underPrice: number | null;
  book: string | null;
}

export interface OddsEvent {
  eventId: string;
  startIso: string;
  homeTeam: string; // tri-code
  awayTeam: string;
  homeTeamFull: string;
  awayTeamFull: string;
  books: BookPrice[];
  spread: SpreadConsensus;
  total: TotalConsensus;
  // Raw bookmaker objects — used by the consensus/public-sharp calc
  rawBookmakers: RawBookmaker[];
}

interface RawOutcome {
  name: string;
  price: number;
  point?: number;
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

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Pick the most common spread/total line across books (modal point), then the
// median price at that line. Keeps the displayed handicap stable.
function consensusSpread(events: RawBookmaker[], homeTeam: string, awayTeam: string): SpreadConsensus {
  const homeByLine: Record<string, { prices: number[]; book: string }> = {};
  const awayByLine: Record<string, number[]> = {};
  for (const bm of events) {
    if (!TRUSTED_BOOKS.includes(bm.key)) continue;
    const mk = bm.markets?.find((m) => m.key === "spreads");
    if (!mk) continue;
    const h = mk.outcomes.find((o) => o.name === homeTeam);
    const a = mk.outcomes.find((o) => o.name === awayTeam);
    if (h?.point !== undefined && h.price !== undefined) {
      const k = String(h.point);
      (homeByLine[k] ??= { prices: [], book: bm.key }).prices.push(h.price);
    }
    if (a?.point !== undefined && a.price !== undefined) {
      (awayByLine[String(a.point)] ??= []).push(a.price);
    }
  }
  const hModal = Object.entries(homeByLine).sort((x, y) => y[1].prices.length - x[1].prices.length)[0];
  const aModal = Object.entries(awayByLine).sort((x, y) => y[1].length - x[1].length)[0];
  if (!hModal || !aModal) {
    return { homeLine: null, homePrice: null, awayLine: null, awayPrice: null, book: null };
  }
  return {
    homeLine: Number(hModal[0]),
    homePrice: Math.round(median(hModal[1].prices)),
    awayLine: Number(aModal[0]),
    awayPrice: Math.round(median(aModal[1])),
    book: hModal[1].book,
  };
}

function consensusTotal(events: RawBookmaker[]): TotalConsensus {
  const overByLine: Record<string, { prices: number[]; book: string }> = {};
  const underByLine: Record<string, number[]> = {};
  for (const bm of events) {
    if (!TRUSTED_BOOKS.includes(bm.key)) continue;
    const mk = bm.markets?.find((m) => m.key === "totals");
    if (!mk) continue;
    const over = mk.outcomes.find((o) => o.name === "Over");
    const under = mk.outcomes.find((o) => o.name === "Under");
    if (over?.point !== undefined && over.price !== undefined) {
      (overByLine[String(over.point)] ??= { prices: [], book: bm.key }).prices.push(over.price);
    }
    if (under?.point !== undefined && under.price !== undefined) {
      (underByLine[String(under.point)] ??= []).push(under.price);
    }
  }
  const oEntries = Object.entries(overByLine).sort((a, b) => b[1].prices.length - a[1].prices.length);
  if (oEntries.length === 0) return { line: null, overPrice: null, underPrice: null, book: null };
  const [line, oData] = oEntries[0];
  const uData = underByLine[line];
  return {
    line: Number(line),
    overPrice: Math.round(median(oData.prices)),
    underPrice: uData ? Math.round(median(uData)) : null,
    book: oData.book,
  };
}

// Generic fetch for any Odds API sport key. nameMapper converts a full team name
// to a tri-code (sport-specific). Defaults to the MLB mapper for back-compat.
export async function fetchOddsForSport(
  sportKey: string,
  nameMapper: (name: string) => string = nameToAbbr,
): Promise<OddsEvent[]> {
  if (!hasOddsKey()) return [];

  const res = await getJson<RawEvent[]>(`${BASE}/${sportKey}/odds/`, {
    apiKey: process.env.ODDS_API_KEY,
    regions: "us",
    markets: "h2h,spreads,totals",
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
      homeTeam: nameMapper(ev.home_team),
      awayTeam: nameMapper(ev.away_team),
      homeTeamFull: ev.home_team,
      awayTeamFull: ev.away_team,
      books,
      spread: consensusSpread(ev.bookmakers ?? [], ev.home_team, ev.away_team),
      total: consensusTotal(ev.bookmakers ?? []),
      rawBookmakers: ev.bookmakers ?? [],
    };
  });
}

// MLB convenience wrapper (back-compat with v1 callers).
export async function fetchOdds(): Promise<OddsEvent[]> {
  return fetchOddsForSport("baseball_mlb", nameToAbbr);
}
