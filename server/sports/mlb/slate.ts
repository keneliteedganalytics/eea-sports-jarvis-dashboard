// Slate service — produces the day's BuiltPick[] for the API. When live odds
// are available it runs the full adapter pipeline; otherwise it falls back to a
// deterministic demo slate so the dashboard renders end-to-end with no keys.

import { predictGame } from "./model";
import { buildPick, applyDailyCap, BANKROLL_USD, type BuiltPick, type GameInput } from "./picksEngine";
import { buildSlate } from "./data";
import { hasOddsKey } from "../../adapters/oddsApi";
import { getOperatingDay, operatingDayAnchor } from "./operatingDay";
import { DEMO_GAMES } from "./demoSlate";
import { umpireAdjustmentForGame, NEUTRAL_UMPIRE, type UmpireAdjustment } from "./umpires";
import { absAdjustmentForPitcher, NEUTRAL_ABS, type AbsAdjustment } from "./abs";

interface PitcherLike {
  pitcher?: string;
  pitcherId?: number | null;
}

async function safeAbs(sp: PitcherLike | undefined): Promise<AbsAdjustment> {
  try {
    return await absAdjustmentForPitcher(sp?.pitcher, sp?.pitcherId ?? null);
  } catch {
    return NEUTRAL_ABS;
  }
}

async function runEngine(games: GameInput[], bankroll = BANKROLL_USD): Promise<BuiltPick[]> {
  // Best-effort external lookups in parallel; any failure degrades to neutral so
  // the slate is never blocked.
  const enrichments = await Promise.all(
    games.map(async (g) => {
      const [umpire, homeAbs, awayAbs] = await Promise.all([
        umpireAdjustmentForGame(g.gamePk).catch(() => NEUTRAL_UMPIRE),
        safeAbs(g.homeSpStats as PitcherLike | undefined),
        safeAbs(g.awaySpStats as PitcherLike | undefined),
      ]);
      return { umpire, homeAbs, awayAbs };
    }),
  );
  const picks = games.map((g, i) => {
    const e = enrichments[i];
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
      umpireAdjustment: e.umpire,
      homeAbs: e.homeAbs,
      awayAbs: e.awayAbs,
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
      return { operatingDay, isDemo: false, bankroll, picks: await runEngine(games, bankroll) };
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
    picks: await runEngine(DEMO_GAMES(opDay), bankroll),
  };
}

export async function getPick(id: string, bankroll = BANKROLL_USD, dateIso?: string): Promise<BuiltPick | null> {
  const slate = await getSlate(bankroll, dateIso);
  return slate.picks.find((p) => p.gameId === id) ?? null;
}
