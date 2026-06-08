// Props service. Joins the day's games with The Odds API per-event player props,
// applies the MLB Poisson edge model, and marks NHL/NBA props uncalibrated
// (display-only) for day one. Falls back to a small demo set with no Odds key.

import { fetchEventProps, hasOddsKey, HEADLINE_MARKETS } from "./oddsApi";
import { mlbPropEdge } from "./model";
import { getDailySlate } from "../slate/orchestrator";
import { demoProps } from "./demo";

export interface PropRow {
  gameId: string;
  sport: string;
  playerName: string;
  team: string;
  market: string;
  line: number;
  overPrice: number;
  underPrice: number;
  book: string;
  modelProb: number | null;
  edgePp: number | null;
  tier: string | null;
  side: string | null;
  uncalibrated: boolean;
}

export interface PropsPayload {
  sport: string;
  date: string;
  props: PropRow[];
}

// Illustrative per-PA rates for the headline MLB batter markets, plus an
// expected-opportunities estimate. Used until a per-player rate feed is wired;
// the Poisson edge math is real, the rate inputs are coarse league-ish priors.
const MLB_RATE: Record<string, { rate: number; opp: number }> = {
  batter_home_runs: { rate: 0.08, opp: 4.3 },
  batter_hits: { rate: 0.25, opp: 4.3 },
  batter_total_bases: { rate: 0.42, opp: 4.3 },
  pitcher_strikeouts: { rate: 1.0, opp: 6.0 }, // per-inning K rate × IP
};

function applyMlbEdge(p: { market: string; line: number; overPrice: number | null; underPrice: number | null }) {
  const r = MLB_RATE[p.market];
  if (!r) return { modelProb: null, edgePp: null, tier: null, side: null, uncalibrated: true };
  const e = mlbPropEdge(r.rate, r.opp, p.line, p.overPrice, p.underPrice);
  // The rates above are league-flat priors, not per-player. The Poisson math is
  // calibrated, but without a per-player rate feed the resulting edge/tier is
  // not trustworthy — surface the fair line but flag it uncalibrated and drop
  // the tier so the UI does not present a coarse edge as an actionable play.
  return { modelProb: e.modelProb, edgePp: null, tier: null, side: e.side, uncalibrated: true };
}

export async function getProps(sport: string, date: string, bankroll: number): Promise<PropsPayload> {
  const sp = sport.toLowerCase();
  if (!HEADLINE_MARKETS[sp]) return { sport: sp, date, props: [] };

  if (!hasOddsKey()) {
    return { sport: sp, date, props: demoProps(sp, date) };
  }

  const slate = await getDailySlate(bankroll);
  const picks = slate.sports[sp as "mlb" | "nhl" | "nba"]?.picks ?? [];

  const out: PropRow[] = [];
  for (const game of picks) {
    const raw = await fetchEventProps(sp, game.gameId).catch(() => []);
    for (const rp of raw) {
      if (rp.overPrice === null && rp.underPrice === null) continue;
      const overPrice = rp.overPrice ?? 0;
      const underPrice = rp.underPrice ?? 0;
      const edge =
        sp === "mlb"
          ? applyMlbEdge({ market: rp.market, line: rp.line, overPrice: rp.overPrice, underPrice: rp.underPrice })
          : { modelProb: null, edgePp: null, tier: null, side: null, uncalibrated: true };
      out.push({
        gameId: game.gameId,
        sport: sp,
        playerName: rp.playerName,
        team: "",
        market: rp.market,
        line: rp.line,
        overPrice,
        underPrice,
        book: rp.book,
        ...edge,
      });
    }
  }
  return { sport: sp, date, props: out };
}
