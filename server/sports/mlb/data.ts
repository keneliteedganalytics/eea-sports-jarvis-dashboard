// Adapter glue — composes odds, schedule, pitcher stats, and weather into
// GameInput records the picks engine can consume. Degrades gracefully: with
// no API keys it returns an empty slate ("no slate today" in the UI).

import { fetchOdds, type OddsEvent, type BookPrice } from "../../adapters/oddsApi";
import { fetchSchedule, fetchPitcherStats, fetchTeamOffense, type ScheduleGame } from "../../adapters/mlbStats";
import { consensusSnhl, bestPrice, type Bookmaker } from "../../core/odds";
import { computePublicSharp, type RawBookmaker } from "../../core/consensus";
import { fetchPolymarketForGame, type PolymarketResult } from "../../adapters/polymarket";
import { getOperatingDay, inOperatingWindow, utcIsoToEtClock } from "./operatingDay";
import { captureSnapshot } from "../../adapters/lineMovement";
import { recentFormForTeam, NEUTRAL_FORM } from "./recentForm";
import { classifyPitcher } from "./pitchers";
import type { GameInput, PolymarketData } from "./picksEngine";
import type { PitcherStats } from "./pitchers";
import type { TeamOffense } from "./ratings";
import { getPitcherSabermetrics } from "./pitcherSabermetrics";
import { getTeamOffenseSaber } from "./teamOffenseSaber";
import { getHandednessSplit } from "./handednessSplits";
import {
  hasApiSportsKey,
  fetchTeamStatistics as fetchApiSportsTeamStats,
  resolveTeamId as resolveApiSportsTeamId,
  fetchGamesByDate as fetchApiSportsGames,
  fetchPitcherStatcast as fetchApiSportsPitcherStatcast,
} from "../../adapters/apiSports";
import type { ApiSportsXcheck } from "./picksEngine";
import type { StarterStatcast } from "./hatfieldRules";
import { getCachedSavantProfile } from "../../adapters/savantStats";

// v6.13.1: best-effort Hatfield Statcast pull for a starter. Primary source is
// Baseball Savant (real xERA/xBA/barrel%/sweet-spot%/BB%); api-sports is a
// secondary fill for any field Savant leaves null. Never throws — returns null
// (rather than an all-null object) when nothing resolves, so the model ctx
// stays a clean no-op and reproduces v6.13.0 output exactly.
async function pitcherStatcastOrNull(
  pitcherId: number | null | undefined,
  season: number,
): Promise<StarterStatcast | null> {
  if (!pitcherId) return null;
  let savant: StarterStatcast | null = null;
  try {
    savant = await getCachedSavantProfile(pitcherId, season);
  } catch {
    savant = null;
  }
  if (!hasApiSportsKey()) return savant;
  let api: StarterStatcast | null = null;
  try {
    api = await fetchApiSportsPitcherStatcast(pitcherId, season);
  } catch {
    api = null;
  }
  if (!savant) return api;
  if (!api) return savant;
  // Savant wins per field; api-sports only fills a gap Savant left null.
  return {
    era: savant.era ?? api.era,
    xera: savant.xera ?? api.xera,
    xbaAllowed: savant.xbaAllowed ?? api.xbaAllowed,
    barrelRatePct: savant.barrelRatePct ?? api.barrelRatePct,
    sweetSpotPct: savant.sweetSpotPct ?? api.sweetSpotPct,
    bbPct: savant.bbPct ?? api.bbPct,
  };
}

// v6.12.1: additive RPG sanity threshold — two feeds within 0.30 RPG agree.
export const API_SPORTS_RPG_ALIGN_THRESHOLD = 0.3;

// Pure: classify two-feed agreement from a pair of (apiSports, mlbStats) RPGs.
// Observability only — never feeds the model. 'no-data' when either side lacks
// a usable api-sports number.
export function computeXcheckAgreement(
  homeApi: number | null,
  homeMlb: number | null,
  awayApi: number | null,
  awayMlb: number | null,
): ApiSportsXcheck {
  const delta = (api: number | null, mlb: number | null): number | null =>
    api !== null && mlb !== null ? Math.abs(api - mlb) : null;
  const homeDelta = delta(homeApi, homeMlb);
  const awayDelta = delta(awayApi, awayMlb);

  let agreement: ApiSportsXcheck["agreement"];
  if (homeDelta === null && awayDelta === null) {
    agreement = "no-data";
  } else {
    const deltas = [homeDelta, awayDelta].filter((d): d is number => d !== null);
    agreement = deltas.every((d) => d <= API_SPORTS_RPG_ALIGN_THRESHOLD)
      ? "aligned"
      : "divergent";
  }
  return {
    home: { rpgApiSports: homeApi, deltaVsMlbStats: homeDelta },
    away: { rpgApiSports: awayApi, deltaVsMlbStats: awayDelta },
    agreement,
  };
}

// Best-effort per-game api-sports RPG cross-check. Resolves both teams' ids and
// pulls their season RPG, comparing to the MLB Stats numbers already in hand.
// Any failure degrades to 'no-data' — the slate is never blocked.
async function apiSportsGameXcheck(
  homeTeamFull: string,
  awayTeamFull: string,
  homeMlbRpg: number | null,
  awayMlbRpg: number | null,
  season: number,
): Promise<ApiSportsXcheck | null> {
  if (!hasApiSportsKey()) return null;
  try {
    const [homeId, awayId] = await Promise.all([
      resolveApiSportsTeamId(homeTeamFull, season).catch(() => null),
      resolveApiSportsTeamId(awayTeamFull, season).catch(() => null),
    ]);
    const [homeStats, awayStats] = await Promise.all([
      fetchApiSportsTeamStats(homeId, season).catch(() => ({ available: false }) as Awaited<ReturnType<typeof fetchApiSportsTeamStats>>),
      fetchApiSportsTeamStats(awayId, season).catch(() => ({ available: false }) as Awaited<ReturnType<typeof fetchApiSportsTeamStats>>),
    ]);
    const homeApi = homeStats.available ? (homeStats.rpg ?? null) : null;
    const awayApi = awayStats.available ? (awayStats.rpg ?? null) : null;
    return computeXcheckAgreement(homeApi, homeMlbRpg, awayApi, awayMlbRpg);
  } catch {
    return computeXcheckAgreement(null, homeMlbRpg, null, awayMlbRpg);
  }
}

// Translate an OddsEvent's BookPrice[] into the Bookmaker[] shape that the
// consensus/best-price helpers expect (h2h market keyed by full team name).
function toBookmakers(ev: OddsEvent): Bookmaker[] {
  return ev.books.map((b: BookPrice) => ({
    key: b.book,
    title: b.book,
    markets: [
      {
        key: "h2h",
        outcomes: [
          ...(b.homePrice !== null ? [{ name: ev.homeTeamFull, price: b.homePrice }] : []),
          ...(b.awayPrice !== null ? [{ name: ev.awayTeamFull, price: b.awayPrice }] : []),
        ],
      },
    ],
  }));
}

function matchSchedule(ev: OddsEvent, schedule: ScheduleGame[]): ScheduleGame | undefined {
  return schedule.find(
    (s) =>
      (s.homeTeam === ev.homeTeam && s.awayTeam === ev.awayTeam) ||
      (s.homeTeamFull === ev.homeTeamFull && s.awayTeamFull === ev.awayTeamFull),
  );
}

function withClassification(p: PitcherStats): PitcherStats {
  const c = classifyPitcher(p);
  return { ...p, classification: c.classification, hardPassReason: c.hardPassReason, sparse: c.sparse, sparseReason: c.sparseReason };
}

export interface SlateBuildResult {
  operatingDay: string;
  games: GameInput[];
  // Set when the slate is empty for a diagnosable reason (not just no games today)
  emptyReason?: string;
  // v6.13.1: true when ≥1 starter resolved a non-null Savant Statcast field this
  // build (drives feeds.savant). False when the Savant feed yielded nothing.
  savantResolved?: boolean;
}

// A Statcast profile "resolved" if any of its fields came back non-null.
function statcastHasData(s: StarterStatcast | null): boolean {
  return (
    s !== null &&
    (s.era !== null ||
      s.xera !== null ||
      s.xbaAllowed !== null ||
      s.barrelRatePct !== null ||
      s.sweetSpotPct !== null ||
      s.bbPct !== null)
  );
}

// Build today's MLB slate. Joins consensus odds with probable pitchers.
export async function buildSlate(now: Date = new Date()): Promise<SlateBuildResult> {
  const opDay = getOperatingDay(now);

  const [oddsEvents, schedule] = await Promise.all([fetchOdds(), fetchSchedule(opDay)]);

  // Filter to games inside the operating-day window.
  const inWindow = oddsEvents.filter((ev) => inOperatingWindow(ev.startIso, opDay));
  if (oddsEvents.length === 0) {
    // the-odds-api returned no events at all — books likely haven't posted lines yet.
    return {
      operatingDay: opDay,
      games: [],
      emptyReason:
        "the-odds-api has not yet posted today's MLB events; lines typically post 4-8 hours before first pitch",
    };
  }
  if (inWindow.length === 0) return { operatingDay: opDay, games: [] };

  // v6.12.1: additive schedule cross-check — one call per slate refresh, only
  // when the api-sports key is present. Logs a warning if the game count drifts
  // from MLB Stats by more than 1. Never affects which games are built.
  if (hasApiSportsKey()) {
    fetchApiSportsGames(opDay)
      .then((r) => {
        if (r.available && Math.abs(r.games.length - schedule.length) > 1) {
          console.warn(
            `[api-sports xcheck] schedule count drift for ${opDay}: api-sports=${r.games.length} vs mlbStats=${schedule.length}`,
          );
        }
      })
      .catch(() => {});
  }

  const games: GameInput[] = [];
  let savantResolved = false;
  for (const ev of inWindow) {
    const bms = toBookmakers(ev);
    const consensus = consensusSnhl(bms, ev.homeTeamFull, ev.awayTeamFull, "shin");
    const [homeMl, homeBook] = bestPrice(bms, ev.homeTeamFull);
    const [awayMl, awayBook] = bestPrice(bms, ev.awayTeamFull);

    const sched = matchSchedule(ev, schedule);

    // v6.10.1: no longer drop TBD-pitcher games — instead build the card with
    // pitchersAnnounced=false so the engine auto-tiers it PASS with an
    // "Awaiting starters" badge. Silently dropping 10 games is worse than a
    // PASS card the user can see. The slate rebuilds every request, so once
    // MLB publishes probables the card re-tiers automatically.
    if (!sched) continue; // no schedule entry at all — genuinely unknown game

    const pitchersAnnounced = sched.homePitcherId !== null && sched.awayPitcherId !== null;

    const year = new Date().getUTCFullYear();
    const [h, a, homeOff, awayOff, polyResult, homeForm, awayForm,
           homePitcherSaber, awayPitcherSaber,
           homeOffSaber, awayOffSaber,
           homeHandedness, awayHandedness] = await Promise.all([
      fetchPitcherStats(sched.homePitcherId, sched.homePitcher),
      fetchPitcherStats(sched.awayPitcherId, sched.awayPitcher),
      fetchTeamOffense(sched.homeTeamId, sched.homeTeamFull).catch(() => ({ available: false }) as TeamOffense),
      fetchTeamOffense(sched.awayTeamId, sched.awayTeamFull).catch(() => ({ available: false }) as TeamOffense),
      // Polymarket lookup — failure is non-fatal, returns found:false
      fetchPolymarketForGame(ev.homeTeamFull, ev.awayTeamFull, opDay, "home")
        .catch((): PolymarketResult => ({ found: false, pct: null, reason: "lookup error" })),
      // Recent-form splits (last-7 / last-14) — best-effort, NEUTRAL on failure
      recentFormForTeam(sched.homeTeamId).catch(() => NEUTRAL_FORM),
      recentFormForTeam(sched.awayTeamId).catch(() => NEUTRAL_FORM),
      // v6.10: sabermetric metrics — best-effort, never block the slate
      sched.homePitcherId ? getPitcherSabermetrics(sched.homePitcherId, year).catch(() => null) : Promise.resolve(null),
      sched.awayPitcherId ? getPitcherSabermetrics(sched.awayPitcherId, year).catch(() => null) : Promise.resolve(null),
      sched.homeTeamId ? getTeamOffenseSaber(sched.homeTeamId, ev.homeTeam, year).catch(() => null) : Promise.resolve(null),
      sched.awayTeamId ? getTeamOffenseSaber(sched.awayTeamId, ev.awayTeam, year).catch(() => null) : Promise.resolve(null),
      sched.homeTeamId ? getHandednessSplit(sched.homeTeamId, ev.homeTeam, year).catch(() => null) : Promise.resolve(null),
      sched.awayTeamId ? getHandednessSplit(sched.awayTeamId, ev.awayTeam, year).catch(() => null) : Promise.resolve(null),
    ]);
    const homeSp: PitcherStats = withClassification(h);
    const awaySp: PitcherStats = withClassification(a);

    // v6.12.1: additive RPG cross-check vs the MLB Stats numbers just fetched.
    // Observability only — never blocks the slate, never feeds the model.
    const apiSportsXcheck = await apiSportsGameXcheck(
      ev.homeTeamFull,
      ev.awayTeamFull,
      homeOff.available ? (homeOff.rpg ?? null) : null,
      awayOff.available ? (awayOff.rpg ?? null) : null,
      year,
    );

    // v6.13: Hatfield Statcast pull per starter (key-gated, null in prod since
    // the baseball plan lacks Statcast → model falls back to league average).
    const [homeSpStatcast, awaySpStatcast] = await Promise.all([
      pitcherStatcastOrNull(homeSp.pitcherId ?? null, year),
      pitcherStatcastOrNull(awaySp.pitcherId ?? null, year),
    ]);
    if (statcastHasData(homeSpStatcast) || statcastHasData(awaySpStatcast)) {
      savantResolved = true;
    }

    // Public / sharp consensus from raw bookmaker data
    const { publicPct, sharpPct } = computePublicSharp(
      ev.rawBookmakers as RawBookmaker[],
      ev.homeTeamFull,
      ev.awayTeamFull,
    );
    // polyResult is keyed to home side; we'll re-orient per pick side in picksEngine
    const polyData: PolymarketData = polyResult.found
      ? { found: true, pct: polyResult.pct, reason: undefined }
      : { found: false, pct: null, reason: polyResult.reason };

    games.push({
      gameId: ev.eventId,
      gamePk: sched?.gamePk ?? null,
      gameDate: opDay,
      gameTimeEt: utcIsoToEtClock(ev.startIso),
      gameStartIso: ev.startIso,
      venue: sched?.venue ?? "",
      homeTeam: ev.homeTeam,
      awayTeam: ev.awayTeam,
      homeTeamFull: ev.homeTeamFull,
      awayTeamFull: ev.awayTeamFull,
      homePitcher: sched?.homePitcher ?? undefined,
      awayPitcher: sched?.awayPitcher ?? undefined,
      mlHome: homeMl,
      mlAway: awayMl,
      mlHomeBook: homeBook,
      mlAwayBook: awayBook,
      homeFairProb: consensus?.homeFairProb ?? null,
      awayFairProb: consensus?.awayFairProb ?? null,
      homeSpStats: homeSp,
      awaySpStats: awaySp,
      homeOffStats: homeOff,
      awayOffStats: awayOff,
      openHomeMl: null,
      openAwayMl: null,
      spreadHomeLine: ev.spread.homeLine,
      spreadHomePrice: ev.spread.homePrice,
      spreadAwayLine: ev.spread.awayLine,
      spreadAwayPrice: ev.spread.awayPrice,
      spreadBook: ev.spread.book,
      totalLine: ev.total.line,
      totalOverPrice: ev.total.overPrice,
      totalUnderPrice: ev.total.underPrice,
      totalBook: ev.total.book,
      _publicPct: publicPct,
      _sharpPct: sharpPct,
      _polymarketData: polyData,
      _oddsEvent: ev,
      _recentFormHome: homeForm,
      _recentFormAway: awayForm,
      // v6.10: sabermetric context
      _homePitcherSaber: homePitcherSaber,
      _awayPitcherSaber: awayPitcherSaber,
      _homeOffenseSaber: homeOffSaber,
      _awayOffenseSaber: awayOffSaber,
      _homeHandedness: homeHandedness,
      _awayHandedness: awayHandedness,
      pitchersAnnounced,
      _apiSportsXcheck: apiSportsXcheck,
      // v6.13: Hatfield Statcast inputs (null = no-op). Series/last-18 spot
      // inputs have no live feed yet → left undefined so those flags never fire.
      _homeSpStatcast: homeSpStatcast,
      _awaySpStatcast: awaySpStatcast,
    });
  }

  // Capture a moneyline snapshot for the in-window events so the line-movement
  // history accrues across slate builds. Best-effort — never blocks the slate.
  captureSnapshot(inWindow, "mlb");

  return { operatingDay: opDay, games, savantResolved };
}
