// Per-player MLB game logs + season splits for the prop simulator. Pulls from
// the public MLB Stats API (statsapi.mlb.com, no key). Everything is best-effort:
// a missing feed returns { available:false } and the simulator skips the prop
// (no fabricated baselines — see spec "no seed/demo data").
//
// The simulator needs three things per batter: a recent game-log window (last
// ~20 games of PA/H/TB/HR/etc.), a season rate anchor, and a lineup-spot guess
// for expected PA. Pitchers need a start log (IP/K/ER/H/BB) and a season anchor.

import { getJson } from "../../adapters/http";

const BASE = "https://statsapi.mlb.com/api/v1";

// ── Game-log shapes ─────────────────────────────────────────────────────────

export interface BatterGameLog {
  date: string;
  pa: number; // plate appearances
  ab: number; // at-bats
  hits: number;
  totalBases: number;
  homeRuns: number;
  runs: number;
  rbi: number;
  walks: number;
  singles: number;
  oppPitcherHand: "L" | "R" | null; // best-effort, often null from the log
  home: boolean;
}

export interface PitcherGameLog {
  date: string;
  outs: number; // IP × 3
  strikeouts: number;
  earnedRuns: number;
  hitsAllowed: number;
  walks: number;
  home: boolean;
}

export interface BatterProfile {
  available: boolean;
  playerId: number | null;
  name: string;
  logs: BatterGameLog[]; // newest-first, capped at the requested window
  seasonPa: number;
  seasonRates: {
    hitsPerPa: number;
    tbPerPa: number;
    hrPerPa: number;
    runsPerPa: number;
    rbiPerPa: number;
    walksPerPa: number;
    singlesPerPa: number;
  } | null;
}

export interface PitcherProfile {
  available: boolean;
  playerId: number | null;
  name: string;
  logs: PitcherGameLog[]; // newest-first
  starts: number;
  seasonRates: {
    kPerOut: number; // strikeouts per out recorded
    outsPerStart: number;
    erPerOut: number;
    hitsPerOut: number;
    walksPerOut: number;
  } | null;
}

// ── Raw API node shapes ─────────────────────────────────────────────────────

interface RawSplitStat {
  plateAppearances?: number | string;
  atBats?: number | string;
  hits?: number | string;
  totalBases?: number | string;
  homeRuns?: number | string;
  runs?: number | string;
  rbi?: number | string;
  baseOnBalls?: number | string;
  doubles?: number | string;
  triples?: number | string;
  // pitching
  inningsPitched?: number | string;
  strikeOuts?: number | string;
  earnedRuns?: number | string;
}
interface RawSplit {
  date?: string;
  isHome?: boolean;
  stat?: RawSplitStat;
}
interface RawStatsGroup {
  splits?: RawSplit[];
}
interface RawPeopleStats {
  stats?: RawStatsGroup[];
}

function n(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const x = Number(v);
  return Number.isNaN(x) ? 0 : x;
}

// MLB reports IP as a decimal where .1 = 1 out, .2 = 2 outs. Convert to outs.
export function inningsToOuts(ip: number | string | undefined): number {
  const s = String(ip ?? "0");
  const [wholeStr, fracStr] = s.split(".");
  const whole = n(wholeStr);
  const frac = fracStr ? n(fracStr[0]) : 0; // .1 → 1 out, .2 → 2 outs
  return whole * 3 + Math.min(frac, 2);
}

function season(): number {
  return new Date().getUTCFullYear();
}

// ── Batter ──────────────────────────────────────────────────────────────────

export async function fetchBatterProfile(
  playerId: number | null,
  name: string,
  window = 20,
): Promise<BatterProfile> {
  const base: BatterProfile = {
    available: false,
    playerId: playerId ?? null,
    name,
    logs: [],
    seasonPa: 0,
    seasonRates: null,
  };
  if (!playerId) return base;

  const res = await getJson<RawPeopleStats>(`${BASE}/people/${playerId}/stats`, {
    stats: "gameLog,season",
    group: "hitting",
    season: season(),
  });
  if (!res.ok || !res.data?.stats) return base;

  // The two stat groups come back in request order: gameLog first, season second.
  const gameLogSplits = res.data.stats[0]?.splits ?? [];
  const seasonSplit = res.data.stats[1]?.splits?.[0]?.stat;

  const logs: BatterGameLog[] = gameLogSplits.map((sp) => {
    const st = sp.stat ?? {};
    const doubles = n(st.doubles);
    const triples = n(st.triples);
    const hr = n(st.homeRuns);
    const hits = n(st.hits);
    const tb = n(st.totalBases) || hits + doubles + 2 * triples + 3 * hr;
    const singles = Math.max(0, hits - doubles - triples - hr);
    return {
      date: sp.date ?? "",
      pa: n(st.plateAppearances),
      ab: n(st.atBats),
      hits,
      totalBases: tb,
      homeRuns: hr,
      runs: n(st.runs),
      rbi: n(st.rbi),
      walks: n(st.baseOnBalls),
      singles,
      oppPitcherHand: null,
      home: sp.isHome ?? false,
    };
  });
  // gameLog is oldest-first from the API; we want newest-first, capped.
  logs.reverse();
  const windowed = logs.slice(0, window);

  let seasonRates: BatterProfile["seasonRates"] = null;
  let seasonPa = 0;
  if (seasonSplit) {
    seasonPa = n(seasonSplit.plateAppearances);
    if (seasonPa > 0) {
      const hits = n(seasonSplit.hits);
      const doubles = n(seasonSplit.doubles);
      const triples = n(seasonSplit.triples);
      const hr = n(seasonSplit.homeRuns);
      const tb = n(seasonSplit.totalBases) || hits + doubles + 2 * triples + 3 * hr;
      const singles = Math.max(0, hits - doubles - triples - hr);
      seasonRates = {
        hitsPerPa: hits / seasonPa,
        tbPerPa: tb / seasonPa,
        hrPerPa: hr / seasonPa,
        runsPerPa: n(seasonSplit.runs) / seasonPa,
        rbiPerPa: n(seasonSplit.rbi) / seasonPa,
        walksPerPa: n(seasonSplit.baseOnBalls) / seasonPa,
        singlesPerPa: singles / seasonPa,
      };
    }
  }

  return {
    available: windowed.length > 0 || seasonRates !== null,
    playerId,
    name,
    logs: windowed,
    seasonPa,
    seasonRates,
  };
}

// ── Pitcher ───────────────────────────────────────────────────────────────────

export async function fetchPitcherProfile(
  playerId: number | null,
  name: string,
  window = 20,
): Promise<PitcherProfile> {
  const base: PitcherProfile = {
    available: false,
    playerId: playerId ?? null,
    name,
    logs: [],
    starts: 0,
    seasonRates: null,
  };
  if (!playerId) return base;

  const res = await getJson<RawPeopleStats>(`${BASE}/people/${playerId}/stats`, {
    stats: "gameLog,season",
    group: "pitching",
    season: season(),
  });
  if (!res.ok || !res.data?.stats) return base;

  const gameLogSplits = res.data.stats[0]?.splits ?? [];
  const seasonSplit = res.data.stats[1]?.splits?.[0]?.stat;

  const logs: PitcherGameLog[] = gameLogSplits.map((sp) => {
    const st = sp.stat ?? {};
    return {
      date: sp.date ?? "",
      outs: inningsToOuts(st.inningsPitched),
      strikeouts: n(st.strikeOuts),
      earnedRuns: n(st.earnedRuns),
      hitsAllowed: n(st.hits),
      walks: n(st.baseOnBalls),
      home: sp.isHome ?? false,
    };
  });
  logs.reverse();
  const windowed = logs.slice(0, window);

  let seasonRates: PitcherProfile["seasonRates"] = null;
  let starts = 0;
  if (seasonSplit) {
    const outs = inningsToOuts(seasonSplit.inningsPitched);
    starts = windowed.length;
    if (outs > 0) {
      seasonRates = {
        kPerOut: n(seasonSplit.strikeOuts) / outs,
        outsPerStart: windowed.length > 0 ? outs / Math.max(1, windowed.length) : outs / 5,
        erPerOut: n(seasonSplit.earnedRuns) / outs,
        hitsPerOut: n(seasonSplit.hits) / outs,
        walksPerOut: n(seasonSplit.baseOnBalls) / outs,
      };
    }
  }

  return {
    available: windowed.length > 0 || seasonRates !== null,
    playerId,
    name,
    logs: windowed,
    starts: windowed.length || starts,
    seasonRates,
  };
}
