// Match a persisted pick's teams to an ESPN event. Abbreviations don't always
// agree between our slate and ESPN (we use WSH, ESPN uses WAS; we use SF, ESPN
// uses SFG), so we normalize a small variant table, match on abbreviation first,
// and fall back to a display-name containment check.

import type { EspnGame } from "../adapters/espnLive";
import type { GradedPick } from "../gradedBook";

// Variant → our canonical tri-code. Bidirectional-ish: we normalize both our
// stored abbreviation and ESPN's before comparing, so either spelling matches.
const ABBR_NORMALIZE: Record<string, string> = {
  // MLB
  WAS: "WSH",
  WSN: "WSH",
  SFG: "SF",
  SDG: "SD",
  SDP: "SD",
  TBR: "TB",
  KCR: "KC",
  CHW: "CWS",
  // NBA
  GS: "GSW",
  NO: "NOP",
  NY: "NYK",
  SA: "SAS",
  UTAH: "UTA",
  PHO: "PHX",
  WSH_NBA: "WAS",
  // NHL
  TBL: "TB",
  LA: "LAK",
  SJ: "SJS",
  NJ: "NJD",
  VGK: "VGK",
  WPG: "WPG",
};

export function normTeamAbbr(abbr: string): string {
  const a = (abbr ?? "").trim().toUpperCase();
  return ABBR_NORMALIZE[a] ?? a;
}

function nameMatches(espnName: string, ourFull: string): boolean {
  const e = espnName.toLowerCase();
  const o = ourFull.toLowerCase();
  if (!e || !o) return false;
  if (e.includes(o) || o.includes(e)) return true;
  // last-word (nickname) fallback: "Yankees" in "New York Yankees"
  const nick = o.split(/\s+/).slice(-1)[0];
  return nick.length > 2 && e.includes(nick);
}

// Find the ESPN event whose home/away pair matches the pick. Abbreviation match
// first (normalized), display-name containment as a fallback.
export function matchEvent(pick: GradedPick, games: EspnGame[]): EspnGame | null {
  const ph = normTeamAbbr(pick.homeTeam);
  const pa = normTeamAbbr(pick.awayTeam);

  for (const g of games) {
    const gh = normTeamAbbr(g.home.abbreviation);
    const ga = normTeamAbbr(g.away.abbreviation);
    if (gh === ph && ga === pa) return g;
  }
  for (const g of games) {
    const homeOk = nameMatches(g.home.displayName, pick.homeTeamFull);
    const awayOk = nameMatches(g.away.displayName, pick.awayTeamFull);
    if (homeOk && awayOk) return g;
  }
  return null;
}
