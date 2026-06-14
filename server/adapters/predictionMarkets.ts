// v6.9.0 — unified prediction-market read (Pillar "predict" signal source).
//
// Wraps the existing Polymarket adapter as the PRIMARY source and adds Kalshi as
// a FALLBACK so a single dead/unmatched venue no longer blanks the predict bar.
// We do NOT duplicate Polymarket's matching logic — fetchPolymarketForGame stays
// the source of truth for that venue. This module only adds the fallback layer
// and a venue-agnostic result shape.
//
// Order: Polymarket → (on miss/unavailable) Kalshi → (on miss) found:false.
// Every step is best-effort and non-fatal: an upstream failure degrades to the
// next venue, never throws, and a total miss returns an honest reason string.

import { getJson } from "./http";
import {
  fetchPolymarketForGame,
  type PolymarketResult,
  type PolySport,
} from "./polymarket";

export type PredictionVenue = "polymarket" | "kalshi";

export interface PredictionMarketResult {
  found: boolean;
  pct: number | null;        // 0-100 win prob for the pick side, null when not found
  venue: PredictionVenue | null;
  reason?: string;
  title?: string | null;
}

const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";
const KALSHI_TIMEOUT_MS = 8000;

// Map a Polymarket sport to the same key Kalshi uses for series filtering. Only
// MLB is wired today; the rest fall through to a no-op so we never guess a
// series that produces a wrong-game match.
const KALSHI_SERIES: Partial<Record<PolySport, string>> = {
  mlb: "KXMLBGAME",
};

// Minimal Kalshi shapes (only the fields we read).
interface KalshiMarket {
  ticker?: string;
  title?: string;
  yes_sub_title?: string;
  status?: string;
  yes_bid?: number;   // cents 0-100
  yes_ask?: number;   // cents 0-100
  last_price?: number; // cents 0-100
  close_time?: string;
}
interface KalshiMarketsResponse {
  markets?: KalshiMarket[];
}

function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Loose token containment so a team nickname/city/abbrev matches a market title.
function nameInText(team: string, text: string): boolean {
  const t = normalize(text);
  for (const tok of normalize(team).split(" ")) {
    if (tok.length >= 3 && t.includes(tok)) return true;
  }
  return false;
}

// Convert a Kalshi cents price (0-100) to a 0-100 pct, preferring the midpoint
// of bid/ask when both exist, else last_price.
function kalshiPct(m: KalshiMarket): number | null {
  const bid = typeof m.yes_bid === "number" ? m.yes_bid : null;
  const ask = typeof m.yes_ask === "number" ? m.yes_ask : null;
  if (bid !== null && ask !== null && bid > 0 && ask > 0) {
    return Math.round(((bid + ask) / 2) * 10) / 10;
  }
  if (typeof m.last_price === "number" && m.last_price > 0) {
    return Math.round(m.last_price * 10) / 10;
  }
  return null;
}

// Fallback venue. Best-effort: returns found:false on any miss/failure. We match
// a same-day market whose title references the pick-side team and read its YES
// price as that team's win probability.
export async function fetchKalshiForGame(
  homeTeamFull: string,
  awayTeamFull: string,
  gameDateIso: string,
  pickSide: "home" | "away",
  sport: PolySport = "mlb",
): Promise<PredictionMarketResult> {
  const series = KALSHI_SERIES[sport];
  if (!series) {
    return { found: false, pct: null, venue: null, reason: "kalshi sport unsupported" };
  }

  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; }, KALSHI_TIMEOUT_MS);
  try {
    const res = await getJson<KalshiMarketsResponse>(`${KALSHI_BASE}/markets`, {
      series_ticker: series,
      status: "open",
      limit: 200,
    });
    clearTimeout(timer);
    if (timedOut) return { found: false, pct: null, venue: null, reason: "kalshi timeout" };
    if (!res.ok || !res.data?.markets) {
      return { found: false, pct: null, venue: null, reason: "kalshi data unavailable" };
    }

    const target = pickSide === "home" ? homeTeamFull : awayTeamFull;
    const other = pickSide === "home" ? awayTeamFull : homeTeamFull;

    for (const m of res.data.markets) {
      if (m.status && m.status !== "active" && m.status !== "open") continue;
      const text = `${m.title ?? ""} ${m.yes_sub_title ?? ""}`;
      // Require BOTH teams present so we don't latch onto an unrelated matchup.
      if (!nameInText(homeTeamFull, text) || !nameInText(awayTeamFull, text)) continue;
      // Same-day guard via close_time when present.
      if (m.close_time) {
        const close = new Date(m.close_time).getTime();
        const game = new Date(gameDateIso + "T12:00:00Z").getTime();
        if (Number.isFinite(close) && Math.abs(close - game) > 48 * 3_600_000) continue;
      }
      // The YES side names a team in yes_sub_title; only read it when YES is our
      // pick side, otherwise invert (100 − pct) for the opponent.
      const yesIsTarget = nameInText(target, m.yes_sub_title ?? m.title ?? "");
      const yesIsOther = nameInText(other, m.yes_sub_title ?? m.title ?? "");
      const pct = kalshiPct(m);
      if (pct === null) continue;
      if (yesIsTarget && !yesIsOther) {
        return { found: true, pct, venue: "kalshi", title: m.title ?? null };
      }
      if (yesIsOther && !yesIsTarget) {
        return { found: true, pct: Math.round((100 - pct) * 10) / 10, venue: "kalshi", title: m.title ?? null };
      }
    }
    return { found: false, pct: null, venue: null, reason: "kalshi no market" };
  } catch (e) {
    clearTimeout(timer);
    return {
      found: false,
      pct: null,
      venue: null,
      reason: e instanceof Error ? `kalshi error: ${e.message}` : "kalshi error",
    };
  }
}

function fromPolymarket(r: PolymarketResult): PredictionMarketResult {
  return {
    found: r.found,
    pct: r.pct,
    venue: r.found ? "polymarket" : null,
    reason: r.reason,
    title: r.title ?? null,
  };
}

// Unified entry point: Polymarket first, Kalshi on miss. Never throws.
export async function fetchPredictionMarketForGame(
  homeTeamFull: string,
  awayTeamFull: string,
  gameDateIso: string,
  pickSide: "home" | "away",
  sport: PolySport = "mlb",
): Promise<PredictionMarketResult> {
  const poly = await fetchPolymarketForGame(
    homeTeamFull, awayTeamFull, gameDateIso, pickSide, sport,
  ).catch((): PolymarketResult => ({ found: false, pct: null, reason: "polymarket error" }));

  if (poly.found && poly.pct !== null) return fromPolymarket(poly);

  const kalshi = await fetchKalshiForGame(
    homeTeamFull, awayTeamFull, gameDateIso, pickSide, sport,
  ).catch((): PredictionMarketResult => ({ found: false, pct: null, venue: null, reason: "kalshi error" }));

  if (kalshi.found && kalshi.pct !== null) return kalshi;

  // Both missed — surface the more informative reason (polymarket's).
  return {
    found: false,
    pct: null,
    venue: null,
    reason: poly.reason ?? kalshi.reason ?? "no prediction market",
    title: poly.title ?? null,
  };
}
