// The Odds API adapter — moneyline (h2h) + spreads + totals across US books.
// https://api.the-odds-api.com/v4/sports/{sportKey}/odds/
// Returns [] when ODDS_API_KEY is unset so the app boots without credentials.

import { getJson } from "./http";
import { nameToAbbr } from "../sports/mlb/teams";
import { TRUSTED_BOOKS } from "../core/odds";
import { pickToDkLink } from "../lib/dkLinks";

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

// v6.10: F5 (first-5-innings) consensus prices — same averaging as main market.
export interface F5Prices {
  h2h: { home: number; away: number } | null;
  totals: { line: number; over: number; under: number } | null;
  spreads: { home: { line: number; price: number }; away: { line: number; price: number } } | null;
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
  // v6.9.2: DraftKings one-tap deep-link data (null when DK not in the response)
  dkEventId: string | null;
  dkHomeSelectionId: string | null;
  dkAwaySelectionId: string | null;
  dkHomeDeepLink: string | null;
  dkAwayDeepLink: string | null;
  // v6.10: first-5-innings market prices (null when no book offers F5 lines)
  f5?: F5Prices | null;
}

interface RawOutcome {
  name: string;
  price: number;
  point?: number;
  // The Odds API DraftKings-specific fields (not always present)
  sid?: string;
  link?: string;
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
  // DraftKings sometimes includes an event-level deep link
  event_link?: string;
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

// v6.10: Build F5 consensus from the three F5 market keys.
function consensusF5(bookmakers: RawBookmaker[], homeTeam: string, awayTeam: string): F5Prices {
  // F5 H2H
  const homeH2hPrices: number[] = [];
  const awayH2hPrices: number[] = [];
  for (const bm of bookmakers) {
    if (!TRUSTED_BOOKS.includes(bm.key)) continue;
    const mk = bm.markets?.find((m) => m.key === "h2h_1st_5_innings");
    if (!mk) continue;
    const h = mk.outcomes.find((o) => o.name === homeTeam);
    const a = mk.outcomes.find((o) => o.name === awayTeam);
    if (h?.price !== undefined) homeH2hPrices.push(h.price);
    if (a?.price !== undefined) awayH2hPrices.push(a.price);
  }
  const h2h =
    homeH2hPrices.length > 0 && awayH2hPrices.length > 0
      ? { home: Math.round(median(homeH2hPrices)), away: Math.round(median(awayH2hPrices)) }
      : null;

  // F5 Totals
  const overByLine: Record<string, { prices: number[] }> = {};
  const underByLine: Record<string, number[]> = {};
  for (const bm of bookmakers) {
    if (!TRUSTED_BOOKS.includes(bm.key)) continue;
    const mk = bm.markets?.find((m) => m.key === "totals_1st_5_innings");
    if (!mk) continue;
    const over = mk.outcomes.find((o) => o.name === "Over");
    const under = mk.outcomes.find((o) => o.name === "Under");
    if (over?.point !== undefined && over.price !== undefined) {
      (overByLine[String(over.point)] ??= { prices: [] }).prices.push(over.price);
    }
    if (under?.point !== undefined && under.price !== undefined) {
      (underByLine[String(under.point)] ??= []).push(under.price);
    }
  }
  const tEntries = Object.entries(overByLine).sort((a, b) => b[1].prices.length - a[1].prices.length);
  let totals: F5Prices["totals"] = null;
  if (tEntries.length > 0) {
    const [line, oData] = tEntries[0];
    const uData = underByLine[line];
    if (uData) {
      totals = {
        line: Number(line),
        over: Math.round(median(oData.prices)),
        under: Math.round(median(uData)),
      };
    }
  }

  // F5 Spreads
  const homeSpreadByLine: Record<string, { prices: number[] }> = {};
  const awaySpreadByLine: Record<string, number[]> = {};
  for (const bm of bookmakers) {
    if (!TRUSTED_BOOKS.includes(bm.key)) continue;
    const mk = bm.markets?.find((m) => m.key === "spreads_1st_5_innings");
    if (!mk) continue;
    const h = mk.outcomes.find((o) => o.name === homeTeam);
    const a = mk.outcomes.find((o) => o.name === awayTeam);
    if (h?.point !== undefined && h.price !== undefined) {
      (homeSpreadByLine[String(h.point)] ??= { prices: [] }).prices.push(h.price);
    }
    if (a?.point !== undefined && a.price !== undefined) {
      (awaySpreadByLine[String(a.point)] ??= []).push(a.price);
    }
  }
  const hsEntries = Object.entries(homeSpreadByLine).sort((a, b) => b[1].prices.length - a[1].prices.length);
  let spreads: F5Prices["spreads"] = null;
  if (hsEntries.length > 0) {
    const [hLine, hData] = hsEntries[0];
    const aEntries = Object.entries(awaySpreadByLine).sort((a, b) => b[1].length - a[1].length);
    if (aEntries.length > 0) {
      const [aLine, aData] = aEntries[0];
      spreads = {
        home: { line: Number(hLine), price: Math.round(median(hData.prices)) },
        away: { line: Number(aLine), price: Math.round(median(aData)) },
      };
    }
  }

  return { h2h, totals, spreads };
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

// v6.9.5: Extract DraftKings selection IDs and deep-link URLs from a raw event.
// DK is the "draftkings" bookmaker key; outcomes sometimes carry .sid (selection ID)
// and .link (a direct deep-link / universal link). When those fields are absent we
// call pickToDkLink() which returns a valid https://sportsbook.draftkings.com/…
// URL that iOS routes to the DK app (or web sportsbook) without errors.
function extractDkData(
  ev: RawEvent,
): {
  dkEventId: string | null;
  dkHomeSelectionId: string | null;
  dkAwaySelectionId: string | null;
  dkHomeDeepLink: string | null;
  dkAwayDeepLink: string | null;
} {
  const dk = (ev.bookmakers ?? []).find((bm) => bm.key === "draftkings");
  if (!dk) {
    return {
      dkEventId: null,
      dkHomeSelectionId: null,
      dkAwaySelectionId: null,
      dkHomeDeepLink: null,
      dkAwayDeepLink: null,
    };
  }
  const h2h = dk.markets?.find((m) => m.key === "h2h");
  const homeOutcome = h2h?.outcomes.find((o) => o.name === ev.home_team);
  const awayOutcome = h2h?.outcomes.find((o) => o.name === ev.away_team);

  const dkEventId = ev.id;
  const dkHomeSelectionId = homeOutcome?.sid ?? null;
  const dkAwaySelectionId = awayOutcome?.sid ?? null;

  // Prefer API-supplied outcome.link (a real DK universal link) if present.
  // Fall back to pickToDkLink() which always returns a valid https URL.
  const dkHomeDeepLink = homeOutcome?.link ?? pickToDkLink({ sport: "mlb" });
  const dkAwayDeepLink = awayOutcome?.link ?? pickToDkLink({ sport: "mlb" });

  return { dkEventId, dkHomeSelectionId, dkAwaySelectionId, dkHomeDeepLink, dkAwayDeepLink };
}

// Generic fetch for any Odds API sport key. nameMapper converts a full team name
// to a tri-code (sport-specific). Defaults to the MLB mapper for back-compat.
export async function fetchOddsForSport(
  sportKey: string,
  nameMapper: (name: string) => string = nameToAbbr,
): Promise<OddsEvent[]> {
  if (!hasOddsKey()) return [];

  const baseMarkets = "h2h,spreads,totals";
  const f5Markets =
    process.env.ODDS_API_F5_ENABLED === "true"
      ? ",h2h_1st_5_innings,totals_1st_5_innings,spreads_1st_5_innings"
      : "";

  let res = await getJson<RawEvent[]>(`${BASE}/${sportKey}/odds/`, {
    apiKey: process.env.ODDS_API_KEY,
    regions: "us",
    markets: baseMarkets + f5Markets,
    oddsFormat: "american",
  });

  // Defensive fallback: if the plan doesn't support F5 markets the API returns
  // 422 INVALID_MARKET for the *entire* request. Retry with base markets only
  // so the main slate self-heals without manual intervention.
  if (res.status === 422 && f5Markets) {
    console.warn(
      "[oddsApi] F5 markets unsupported on current plan (HTTP 422), falling back to base markets",
    );
    res = await getJson<RawEvent[]>(`${BASE}/${sportKey}/odds/`, {
      apiKey: process.env.ODDS_API_KEY,
      regions: "us",
      markets: baseMarkets,
      oddsFormat: "american",
    });
  }

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
    const dk = extractDkData(ev);
    const bms = ev.bookmakers ?? [];
    const f5Raw = consensusF5(bms, ev.home_team, ev.away_team);
    // Only attach f5 when at least h2h prices exist (avoids noisy null objects)
    const f5 = f5Raw.h2h ? f5Raw : null;
    return {
      eventId: ev.id,
      startIso: ev.commence_time,
      homeTeam: nameMapper(ev.home_team),
      awayTeam: nameMapper(ev.away_team),
      homeTeamFull: ev.home_team,
      awayTeamFull: ev.away_team,
      books,
      spread: consensusSpread(bms, ev.home_team, ev.away_team),
      total: consensusTotal(bms),
      rawBookmakers: bms,
      dkEventId: dk.dkEventId,
      dkHomeSelectionId: dk.dkHomeSelectionId,
      dkAwaySelectionId: dk.dkAwaySelectionId,
      dkHomeDeepLink: dk.dkHomeDeepLink,
      dkAwayDeepLink: dk.dkAwayDeepLink,
      f5,
    };
  });
}

// MLB convenience wrapper (back-compat with v1 callers).
export async function fetchOdds(): Promise<OddsEvent[]> {
  return fetchOddsForSport("baseball_mlb", nameToAbbr);
}
