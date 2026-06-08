// Slate service — produces the day's BuiltPick[] for the API. When live odds
// are available it runs the full adapter pipeline; otherwise it falls back to a
// deterministic demo slate so the dashboard renders end-to-end with no keys.

import { predictGame } from "./model";
import { buildPick, applyDailyCap, BANKROLL_USD, type BuiltPick, type GameInput } from "./picksEngine";
import { buildSlate } from "./data";
import { hasOddsKey } from "../../adapters/oddsApi";
import { getOperatingDay, operatingDayAnchor } from "./operatingDay";
import { DEMO_GAMES } from "./demoSlate";

function runEngine(games: GameInput[], bankroll = BANKROLL_USD): BuiltPick[] {
  const picks = games.map((g) => {
    const model = predictGame({
      homeTeam: g.homeTeam,
      awayTeam: g.awayTeam,
      homeTeamFull: g.homeTeamFull,
      awayTeamFull: g.awayTeamFull,
      homeSpStats: g.homeSpStats ?? {},
      awaySpStats: g.awaySpStats ?? {},
      homeOffStats: g.homeOffStats ?? {},
      awayOffStats: g.awayOffStats ?? {},
      venueTriCode: g.homeTeam,
      homeFairProb: g.homeFairProb,
      awayFairProb: g.awayFairProb,
    });
    return buildPick(g, model, bankroll);
  });
  return applyDailyCap(picks);
}

export interface SlatePayload {
  operatingDay: string;
  isDemo: boolean;
  bankroll: number;
  picks: BuiltPick[];
}

export async function getSlate(bankroll = BANKROLL_USD, dateIso?: string): Promise<SlatePayload> {
  const now = dateIso ? operatingDayAnchor(dateIso) : new Date();
  if (hasOddsKey()) {
    const { operatingDay, games } = await buildSlate(now);
    if (games.length > 0) {
      return { operatingDay, isDemo: false, bankroll, picks: runEngine(games, bankroll) };
    }
    // Odds key is present but no games found (e.g. future date / off-day).
    // Return a live (non-demo) empty slate rather than falling through to demo.
    return { operatingDay, isDemo: false, bankroll, picks: [] };
  }
  // Fallback: deterministic demo slate (no Odds key configured).
  const opDay = getOperatingDay(now);
  return {
    operatingDay: opDay,
    isDemo: true,
    bankroll,
    picks: runEngine(DEMO_GAMES(opDay), bankroll),
  };
}

export async function getPick(id: string, bankroll = BANKROLL_USD, dateIso?: string): Promise<BuiltPick | null> {
  const slate = await getSlate(bankroll, dateIso);
  return slate.picks.find((p) => p.gameId === id) ?? null;
}
