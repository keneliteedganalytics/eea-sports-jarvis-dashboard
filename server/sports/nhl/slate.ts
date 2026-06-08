// NHL slate service — runs the goals model + picks engine over live odds, or a
// deterministic demo slate when no Odds key is configured.

import { predictGame } from "./model";
import { buildPick, applyDailyCap, BANKROLL_USD, type NhlGameInput } from "./picksEngine";
import { buildNhlSlate } from "./data";
import { hasOddsKey } from "../../adapters/oddsApi";
import { operatingDayAnchor } from "../mlb/operatingDay";
import { DEMO_NHL_GAMES } from "./demoSlate";
import type { BuiltPick } from "../mlb/picksEngine";

function operatingDay(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function runEngine(games: NhlGameInput[], bankroll = BANKROLL_USD): BuiltPick[] {
  const picks = games.map((g) => {
    const model = predictGame({
      homeTeam: g.homeTeam,
      awayTeam: g.awayTeam,
      homeTeamFull: g.homeTeamFull,
      awayTeamFull: g.awayTeamFull,
      homeStats: g._homeStats ?? {},
      awayStats: g._awayStats ?? {},
      homeGoalie: g._homeGoalie ?? null,
      awayGoalie: g._awayGoalie ?? null,
      homeFairProb: g.homeFairProb,
      awayFairProb: g.awayFairProb,
    });
    return buildPick(g, model, bankroll);
  });
  return applyDailyCap(picks);
}

export interface NhlSlatePayload {
  operatingDay: string;
  isDemo: boolean;
  bankroll: number;
  picks: BuiltPick[];
}

export async function getNhlSlate(bankroll = BANKROLL_USD, dateIso?: string): Promise<NhlSlatePayload> {
  const now = dateIso ? operatingDayAnchor(dateIso) : new Date();
  if (hasOddsKey()) {
    const { operatingDay, games } = await buildNhlSlate(now);
    if (games.length > 0) {
      return { operatingDay, isDemo: false, bankroll, picks: runEngine(games, bankroll) };
    }
  }
  const opDay = operatingDay(now);
  return {
    operatingDay: opDay,
    isDemo: true,
    bankroll,
    picks: runEngine(DEMO_NHL_GAMES(opDay), bankroll),
  };
}

export async function getNhlPick(id: string, bankroll = BANKROLL_USD, dateIso?: string): Promise<BuiltPick | null> {
  const slate = await getNhlSlate(bankroll, dateIso);
  return slate.picks.find((p) => p.gameId === id) ?? null;
}
