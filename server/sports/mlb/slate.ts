// Slate service — produces the day's BuiltPick[] for the API. When live odds
// are available it runs the full adapter pipeline; otherwise it falls back to a
// deterministic demo slate so the dashboard renders end-to-end with no keys.

import { predictGame } from "./model";
import { buildPick, applyDailyCap, BANKROLL_USD, type BuiltPick, type GameInput } from "./picksEngine";
import { buildSlate } from "./data";
import { hasOddsKey } from "../../adapters/oddsApi";
import { hasWeatherKey } from "../../adapters/openWeather";
import { hasApiSportsKey } from "../../adapters/apiSports";
import { getOperatingDay, operatingDayAnchor } from "./operatingDay";
import { DEMO_GAMES } from "./demoSlate";
import { umpireAdjustmentForGame, NEUTRAL_UMPIRE, type UmpireAdjustment } from "./umpires";
import { absAdjustmentForPitcher, NEUTRAL_ABS, type AbsAdjustment } from "./abs";
import { fetchLineups, lineupStatusForSide, PENDING_LINEUP, type LineupResult } from "./lineups";
// v6.12: advanced pillars — fetched in parallel, all degrade to null on failure
import {
  pitcherRecentForm,
  type HitterRecentForm,
} from "../../sources/recentForm";
import {
  isKeyBatOut,
} from "../../sources/injuries";
import {
  fetchPitcherArsenals,
} from "../../sources/pitchMix";
import {
  bullpenLoadForTeam,
} from "../../sources/bullpenLoad";

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

async function runEngine(games: GameInput[], bankroll = BANKROLL_USD, dateStr?: string): Promise<BuiltPick[]> {
  // Posted batting orders for the date (one call covers every game). Best-effort:
  // an empty map means lineups haven't posted, so every side stays "pending".
  const lineups: Record<string, { home: string[]; away: string[] }> = dateStr
    ? await fetchLineups(dateStr).catch(() => ({}))
    : {};

  // v6.12: pre-fetch pitcher arsenals once (shared across all games this slate).
  // Failure degrades to an empty map — pitch-mix adjustments become no-ops.
  const arsenals = await fetchPitcherArsenals().catch(() => new Map());
  void arsenals; // reserved for future per-player pitch-mix expansion

  // Best-effort external lookups in parallel; any failure degrades to neutral so
  // the slate is never blocked.
  const enrichments = await Promise.all(
    games.map(async (g) => {
      // Grab pitcher IDs from stats objects for recent-form lookups.
      const homeSp = g.homeSpStats as Record<string, unknown> | undefined;
      const awaySp = g.awaySpStats as Record<string, unknown> | undefined;
      const homeSpId = (homeSp?.pitcherId as number | null) ?? null;
      const awaySpId = (awaySp?.pitcherId as number | null) ?? null;

      // v6.12: fetch all four advanced pillars in parallel, each .catch(() => null)
      // so any single failure degrades to a no-op.
      const [
        umpire, homeAbs, awayAbs,
        homeSpRf, awaySpRf,
        homeInj, awayInj,
        homeBpLoad, awayBpLoad,
      ] = await Promise.all([
        umpireAdjustmentForGame(g.gamePk).catch(() => NEUTRAL_UMPIRE),
        safeAbs(g.homeSpStats as PitcherLike | undefined),
        safeAbs(g.awaySpStats as PitcherLike | undefined),
        // Pillar 1a: SP recent form (last-5 starts ERA)
        pitcherRecentForm(homeSpId, (homeSp?.pitcher as string) ?? "").catch(() => null),
        pitcherRecentForm(awaySpId, (awaySp?.pitcher as string) ?? "").catch(() => null),
        // Pillar 2: injuries (no bats roster wired yet — degrades to NEUTRAL)
        isKeyBatOut(null, g.gamePk ?? null, "home", []).catch(() => null),
        isKeyBatOut(null, g.gamePk ?? null, "away", []).catch(() => null),
        // Pillar 4: bullpen fatigue (teamId not yet in GameInput — degrades to null)
        bullpenLoadForTeam(null).catch(() => null),
        bullpenLoadForTeam(null).catch(() => null),
      ]);

      // Pillar 1b: top-of-order batter recent form — hitterRecentForm needs playerIds;
      // without a roster feed we pass null (no-op). Future: wire via data.ts.
      const homeTopBattersRf: HitterRecentForm | null = null;
      const awayTopBattersRf: HitterRecentForm | null = null;

      // Pillar 3: pitch-mix matchup delta — requires per-player Savant pitch-value
      // data not yet in GameInput. Passes null (no-op). Future: wire via data.ts.
      const homePitchMix: number | null = null;
      const awayPitchMix: number | null = null;

      // Star lists are not yet wired (needs per-player wRC+); with none supplied
      // lineupStatusForSide reports confirmed/pending only — a no-op for sizing.
      const posted = g.gamePk ? lineups[String(g.gamePk)] : undefined;
      const homeLineup: LineupResult = posted
        ? lineupStatusForSide(posted.home, [])
        : PENDING_LINEUP;
      const awayLineup: LineupResult = posted
        ? lineupStatusForSide(posted.away, [])
        : PENDING_LINEUP;

      return {
        umpire, homeAbs, awayAbs, homeLineup, awayLineup,
        homeSpRf, awaySpRf,
        homeTopBattersRf, awayTopBattersRf,
        homeInj, awayInj,
        homePitchMix, awayPitchMix,
        homeBpLoad, awayBpLoad,
      };
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
      // v6.10: sabermetric context
      homePitcherSaber: g._homePitcherSaber ?? null,
      awayPitcherSaber: g._awayPitcherSaber ?? null,
      homeOffenseSaber: g._homeOffenseSaber ?? null,
      awayOffenseSaber: g._awayOffenseSaber ?? null,
      homeHandedness: g._homeHandedness ?? null,
      awayHandedness: g._awayHandedness ?? null,
      // v6.12: advanced pillars (all optional, null = no-op)
      homeSpRecentForm: e.homeSpRf ?? null,
      awaySpRecentForm: e.awaySpRf ?? null,
      homeTopBattersRecentForm: e.homeTopBattersRf ?? null,
      awayTopBattersRecentForm: e.awayTopBattersRf ?? null,
      homeInjuries: e.homeInj ?? null,
      awayInjuries: e.awayInj ?? null,
      homePitchMix: e.homePitchMix ?? null,
      awayPitchMix: e.awayPitchMix ?? null,
      homeBpFatigue: e.homeBpLoad?.fatigue ?? null,
      awayBpFatigue: e.awayBpLoad?.fatigue ?? null,
    });
    return buildPick({ ...g, _lineupHome: e.homeLineup, _lineupAway: e.awayLineup }, model, bankroll);
  });
  return applyDailyCap(picks);
}

// v6.12.1: which upstream feeds are live for this slate build (key presence).
export interface SlateFeeds {
  mlbStats: boolean;
  oddsApi: boolean;
  apiSports: boolean;
  openWeather: boolean;
}

export interface SlatePayload {
  operatingDay: string;
  isDemo: boolean;
  bankroll: number;
  picks: BuiltPick[];
  // v6.10.1: set when the slate is empty for a diagnosable reason (not just off-day)
  emptyReason?: string;
  // v6.12.1: live-feed snapshot (observability only).
  feeds?: SlateFeeds;
}

// MLB Stats API needs no key (free public API), so it's always considered live.
function currentFeeds(): SlateFeeds {
  return {
    mlbStats: true,
    oddsApi: hasOddsKey(),
    apiSports: hasApiSportsKey(),
    openWeather: hasWeatherKey(),
  };
}

export async function getSlate(bankroll = BANKROLL_USD, dateIso?: string): Promise<SlatePayload> {
  const now = dateIso ? operatingDayAnchor(dateIso) : new Date();
  if (hasOddsKey()) {
    const { operatingDay, games, emptyReason } = await buildSlate(now);
    if (games.length > 0) {
      return { operatingDay, isDemo: false, bankroll, picks: await runEngine(games, bankroll, operatingDay), feeds: currentFeeds() };
    }
    // Odds key is present but no games found (e.g. future date / off-day, or
    // the-odds-api hasn't posted lines yet). Return the emptyReason so the client
    // can render an informative empty-state instead of a blank slate.
    return { operatingDay, isDemo: false, bankroll, picks: [], emptyReason, feeds: currentFeeds() };
  }
  // Fallback: deterministic demo slate (no Odds key configured).
  const opDay = getOperatingDay(now);
  return {
    operatingDay: opDay,
    isDemo: true,
    bankroll,
    picks: await runEngine(DEMO_GAMES(opDay), bankroll, opDay),
    feeds: currentFeeds(),
  };
}

export async function getPick(id: string, bankroll = BANKROLL_USD, dateIso?: string): Promise<BuiltPick | null> {
  const slate = await getSlate(bankroll, dateIso);
  return slate.picks.find((p) => p.gameId === id) ?? null;
}
