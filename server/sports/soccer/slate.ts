// Soccer slate service — runs the Dixon-Coles model + picks engine over live
// soccer odds, or falls back to a deterministic demo slate when no Odds key
// is configured. Respects same ?date= / operating-day anchor as MLB/NHL/NBA.

import { predictGame } from "./model";
import { DISPLAY_TIMEZONE } from "../../utils/timezone";
import { buildPick, applyDailyCap, BANKROLL_USD, type SoccerGameInput, type SoccerPick } from "./picksEngine";
import { buildSoccerSlate } from "./data";
import { hasOddsKey } from "../../adapters/oddsApi";
import { operatingDayAnchor } from "../mlb/operatingDay";
import { DEMO_SOCCER_GAMES } from "./demoSlate";
import type { TeamGoalStats } from "./model";

function operatingDay(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: DISPLAY_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

// Run the engine over a batch of soccer game inputs.
function runEngine(
  games: (SoccerGameInput & { _homeStats?: TeamGoalStats; _awayStats?: TeamGoalStats })[],
  bankroll = BANKROLL_USD,
): SoccerPick[] {
  const picks: SoccerPick[] = [];
  for (const g of games) {
    try {
      const model = predictGame({
        homeTeam: g.homeTeam,
        awayTeam: g.awayTeam,
        homeTeamFull: g.homeTeamFull,
        awayTeamFull: g.awayTeamFull,
        homeStats: (g as SoccerGameInput & { _homeStats?: TeamGoalStats })._homeStats ?? { available: false },
        awayStats: (g as SoccerGameInput & { _awayStats?: TeamGoalStats })._awayStats ?? { available: false },
        homeFairProb: g.homeFairProb,
        awayFairProb: g.awayFairProb,
        drawFairProb: g.drawFairProb,
        isFriendly: g.isFriendly,
        isWorldCupMatchday1: g.isWorldCupMatchday1 ?? false,
        leagueName: g.leagueName,
      });
      picks.push(buildPick(g, model, bankroll));
    } catch {
      // Never let one game crash the whole slate
    }
  }
  return applyDailyCap(picks);
}

export interface SoccerSlatePayload {
  operatingDay: string;
  isDemo: boolean;
  bankroll: number;
  picks: SoccerPick[];
}

export async function getSoccerSlate(
  bankroll = BANKROLL_USD,
  dateIso?: string,
): Promise<SoccerSlatePayload> {
  const now = dateIso ? operatingDayAnchor(dateIso) : new Date();

  if (hasOddsKey()) {
    try {
      const { operatingDay: opDay, games } = await buildSoccerSlate(now);
      // When we have a live Odds API key, always return real data — even if the
      // schedule is legitimately empty (off-day / no covered leagues).
      return {
        operatingDay: opDay,
        isDemo: false,
        bankroll,
        picks: runEngine(games, bankroll),
      };
    } catch {
      // Fall through to demo only on hard error
    }
  }

  const opDay = operatingDay(now);
  return {
    operatingDay: opDay,
    isDemo: true,
    bankroll,
    picks: runEngine(DEMO_SOCCER_GAMES(opDay) as unknown as (SoccerGameInput & { _homeStats?: TeamGoalStats; _awayStats?: TeamGoalStats })[], bankroll),
  };
}

export async function getSoccerPick(
  id: string,
  bankroll = BANKROLL_USD,
  dateIso?: string,
): Promise<SoccerPick | null> {
  const slate = await getSoccerSlate(bankroll, dateIso);
  return slate.picks.find((p) => p.gameId === id) ?? null;
}
