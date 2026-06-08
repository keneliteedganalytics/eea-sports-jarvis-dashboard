// Public / Sharp consensus computation from Odds API bookmaker data.
//
// PublicPct  = average de-vigged implied probability across soft/public books
//              (DraftKings, FanDuel, BetMGM, Caesars) for the pick side.
// SharpPct   = implied probability from sharp/market books
//              (Pinnacle first, then CircaSports, BetOnlineAG) for the pick side.
//              If no sharp book is available, falls back to the Shin de-vigged
//              consensus across all available books.
//
// All probabilities are de-juiced before returning (so they're true probs,
// not raw implied probs that sum to >100%).

import { americanToProb, devigAdditive, devigShin } from "./odds";

const PUBLIC_BOOKS = ["draftkings", "fanduel", "betmgm", "caesars"];
const SHARP_BOOKS  = ["pinnacle", "circasports", "betonlineag"];

interface RawOutcome {
  name: string;
  price: number;
}
interface RawMarket {
  key: string;
  outcomes: RawOutcome[];
}
export interface RawBookmaker {
  key: string;
  title?: string;
  markets?: RawMarket[];
}

export interface ConsensusResult {
  publicPct: number | null;  // 0-100
  sharpPct:  number | null;  // 0-100
}

// Extract the h2h price for a team from a single bookmaker's data.
function h2hPrice(bm: RawBookmaker, teamName: string): number | null {
  const h2h = bm.markets?.find((m) => m.key === "h2h");
  if (!h2h) return null;
  const o = h2h.outcomes?.find((o) => o.name === teamName);
  return o?.price ?? null;
}

// De-vig a two-way market and return the true probability for team A.
function devig(priceA: number, priceB: number): number | null {
  // Try Shin first; fall back to additive
  const [pa] = devigShin(priceA, priceB);
  if (pa !== null) return pa;
  const [paA] = devigAdditive(priceA, priceB);
  return paA;
}

export function computePublicSharp(
  bookmakers: RawBookmaker[],
  pickTeamFull: string,
  oppTeamFull: string,
): ConsensusResult {
  // ── Public: average de-vigged prob from public books ──────────────────
  const publicProbs: number[] = [];
  for (const bm of bookmakers) {
    if (!PUBLIC_BOOKS.includes(bm.key)) continue;
    const pickP = h2hPrice(bm, pickTeamFull);
    const oppP  = h2hPrice(bm, oppTeamFull);
    if (pickP === null || oppP === null) continue;
    const p = devig(pickP, oppP);
    if (p !== null) publicProbs.push(p);
  }
  const publicPct =
    publicProbs.length > 0
      ? Math.round((publicProbs.reduce((s, x) => s + x, 0) / publicProbs.length) * 1000) / 10
      : null;

  // ── Sharp: use highest-priority sharp book available ──────────────────
  let sharpPct: number | null = null;

  for (const sharpKey of SHARP_BOOKS) {
    const bm = bookmakers.find((b) => b.key === sharpKey);
    if (!bm) continue;
    const pickP = h2hPrice(bm, pickTeamFull);
    const oppP  = h2hPrice(bm, oppTeamFull);
    if (pickP === null || oppP === null) continue;
    const p = devig(pickP, oppP);
    if (p !== null) {
      sharpPct = Math.round(p * 1000) / 10;
      break;
    }
  }

  // Fallback: de-vig consensus across all available books
  if (sharpPct === null) {
    const allProbs: number[] = [];
    for (const bm of bookmakers) {
      const pickP = h2hPrice(bm, pickTeamFull);
      const oppP  = h2hPrice(bm, oppTeamFull);
      if (pickP === null || oppP === null) continue;
      const p = devig(pickP, oppP);
      if (p !== null) allProbs.push(p);
    }
    if (allProbs.length > 0) {
      const avg = allProbs.reduce((s, x) => s + x, 0) / allProbs.length;
      sharpPct = Math.round(avg * 1000) / 10;
    }
  }

  return { publicPct, sharpPct };
}
