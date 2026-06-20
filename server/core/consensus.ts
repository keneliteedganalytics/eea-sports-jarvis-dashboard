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
//
// Fix 4: Handle (dollar volume) vs bet-count divergence
// When ODDS_API_HANDLE_ENABLED=true, books on premium Odds API tiers expose
// handle_pct alongside bet_pct per outcome. publicHandlePct / sharpHandlePct
// surface this when available. handleVsBetDivergence() flags classic sharp-money
// signals (handle >> bets on one side despite opposing public count).
//
// NOTE: publicHandlePct / sharpHandlePct are NOT wired into picksEngine.ts yet.
// TODO(assembleSignals): read handlePct fields from ConsensusResult in a follow-up
// PR once the pillars PR lands (v6.12.1). See assembleSignals.ts integration point.

import { americanToProb, devigAdditive, devigShin } from "./odds";

const PUBLIC_BOOKS = ["draftkings", "fanduel", "betmgm", "caesars"];
const SHARP_BOOKS  = ["pinnacle", "circasports", "betonlineag"];

interface RawOutcome {
  name: string;
  price: number;
  // Premium Odds API tier fields — present when ODDS_API_HANDLE_ENABLED=true
  handle_pct?: number | null;
  bet_pct?: number | null;
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
  publicPct:       number | null;  // 0-100
  sharpPct:        number | null;  // 0-100
  // Fix 4: handle fields — null when ODDS_API_HANDLE_ENABLED is not "true"
  // or the book doesn't expose handle data on its current plan tier.
  publicHandlePct: number | null;  // weighted avg handle% across public books
  sharpHandlePct:  number | null;  // handle% from the leading sharp book
}

// Extract the h2h price (and optionally handle/bet pct) for a team from one bookmaker.
function h2hOutcome(bm: RawBookmaker, teamName: string): RawOutcome | null {
  const h2h = bm.markets?.find((m) => m.key === "h2h");
  if (!h2h) return null;
  return h2h.outcomes?.find((o) => o.name === teamName) ?? null;
}

// De-vig a two-way market and return the true probability for team A.
function devig(priceA: number, priceB: number): number | null {
  // Try Shin first; fall back to additive
  const [pa] = devigShin(priceA, priceB);
  if (pa !== null) return pa;
  const [paA] = devigAdditive(priceA, priceB);
  return paA;
}

// Return the spread between handle% and bet% for a given side.
// When handle > bet by >10pp, sharp money is leaning that side even if public
// bets disagree — the classic "sharp money tell".
// Returns null when either input is null/undefined.
export function handleVsBetDivergence(
  handlePct: number | null | undefined,
  betPct: number | null | undefined,
): number | null {
  if (handlePct === null || handlePct === undefined) return null;
  if (betPct === null || betPct === undefined) return null;
  return handlePct - betPct;
}

export function computePublicSharp(
  bookmakers: RawBookmaker[],
  pickTeamFull: string,
  oppTeamFull: string,
): ConsensusResult {
  const handleEnabled = process.env.ODDS_API_HANDLE_ENABLED === "true";

  // ── Public: average de-vigged prob from public books ──────────────────
  const publicProbs: number[] = [];
  const publicHandles: number[] = [];

  for (const bm of bookmakers) {
    if (!PUBLIC_BOOKS.includes(bm.key)) continue;
    const pickOutcome = h2hOutcome(bm, pickTeamFull);
    const oppOutcome  = h2hOutcome(bm, oppTeamFull);
    if (!pickOutcome || !oppOutcome) continue;
    const p = devig(pickOutcome.price, oppOutcome.price);
    if (p !== null) publicProbs.push(p);
    // Collect handle% when enabled and available
    if (handleEnabled && pickOutcome.handle_pct !== null && pickOutcome.handle_pct !== undefined) {
      publicHandles.push(pickOutcome.handle_pct);
    }
  }

  const publicPct =
    publicProbs.length > 0
      ? Math.round((publicProbs.reduce((s, x) => s + x, 0) / publicProbs.length) * 1000) / 10
      : null;

  const publicHandlePct =
    handleEnabled && publicHandles.length > 0
      ? Math.round((publicHandles.reduce((s, x) => s + x, 0) / publicHandles.length) * 10) / 10
      : null;

  // ── Sharp: use highest-priority sharp book available ──────────────────
  let sharpPct: number | null = null;
  let sharpHandlePct: number | null = null;

  for (const sharpKey of SHARP_BOOKS) {
    const bm = bookmakers.find((b) => b.key === sharpKey);
    if (!bm) continue;
    const pickOutcome = h2hOutcome(bm, pickTeamFull);
    const oppOutcome  = h2hOutcome(bm, oppTeamFull);
    if (!pickOutcome || !oppOutcome) continue;
    const p = devig(pickOutcome.price, oppOutcome.price);
    if (p !== null) {
      sharpPct = Math.round(p * 1000) / 10;
      // Capture handle% from the same sharp book when available
      if (handleEnabled && pickOutcome.handle_pct !== null && pickOutcome.handle_pct !== undefined) {
        sharpHandlePct = pickOutcome.handle_pct;
      }
      break;
    }
  }

  // Fallback: de-vig consensus across all available books
  if (sharpPct === null) {
    const allProbs: number[] = [];
    for (const bm of bookmakers) {
      const pickOutcome = h2hOutcome(bm, pickTeamFull);
      const oppOutcome  = h2hOutcome(bm, oppTeamFull);
      if (!pickOutcome || !oppOutcome) continue;
      const p = devig(pickOutcome.price, oppOutcome.price);
      if (p !== null) allProbs.push(p);
    }
    if (allProbs.length > 0) {
      const avg = allProbs.reduce((s, x) => s + x, 0) / allProbs.length;
      sharpPct = Math.round(avg * 1000) / 10;
    }
  }

  return { publicPct, sharpPct, publicHandlePct, sharpHandlePct };
}
