// Team name ↔ tri-code mapping + abbreviation normalization.
// Ported from sports-engine sports/mlb/data.py (NAME_TO_ABBR / ABBR_FIX).
// Tri-codes here are normalized to match PARK_FACTORS keys in weather.ts.

// Park-factor keys use the short forms (KC, WSH, CWS, SD, SF). The engine's
// internal abbreviations (KCR, WSN, CHW, SDP, SFG) are normalized to those.
export const ABBR_FIX: Record<string, string> = {
  KCR: "KC",
  WSN: "WSH",
  CHW: "CWS",
  SDP: "SD",
  SFG: "SF",
  TBR: "TB",
  WAS: "WSH",
};

const NAME_TO_ABBR: Record<string, string> = {
  "Baltimore Orioles": "BAL",
  "Boston Red Sox": "BOS",
  "New York Yankees": "NYY",
  "Tampa Bay Rays": "TB",
  "Toronto Blue Jays": "TOR",
  "Chicago White Sox": "CWS",
  "Cleveland Guardians": "CLE",
  "Cleveland Indians": "CLE",
  "Detroit Tigers": "DET",
  "Kansas City Royals": "KC",
  "Minnesota Twins": "MIN",
  "Houston Astros": "HOU",
  "Los Angeles Angels": "LAA",
  "Los Angeles Angels of Anaheim": "LAA",
  "Anaheim Angels": "LAA",
  "Oakland Athletics": "OAK",
  "Sacramento Athletics": "OAK",
  Athletics: "OAK",
  "Seattle Mariners": "SEA",
  "Texas Rangers": "TEX",
  "Atlanta Braves": "ATL",
  "Miami Marlins": "MIA",
  "New York Mets": "NYM",
  "Philadelphia Phillies": "PHI",
  "Washington Nationals": "WSH",
  "Chicago Cubs": "CHC",
  "Cincinnati Reds": "CIN",
  "Milwaukee Brewers": "MIL",
  "Pittsburgh Pirates": "PIT",
  "St. Louis Cardinals": "STL",
  "Arizona Diamondbacks": "ARI",
  "Colorado Rockies": "COL",
  "Los Angeles Dodgers": "LAD",
  "San Diego Padres": "SD",
  "San Francisco Giants": "SF",
};

export const ABBR_TO_NAME: Record<string, string> = Object.entries(NAME_TO_ABBR).reduce(
  (acc, [name, abbr]) => {
    if (!acc[abbr]) acc[abbr] = name;
    return acc;
  },
  {} as Record<string, string>,
);

export function normAbbr(abbr: string): string {
  const a = (abbr ?? "").trim().toUpperCase();
  return ABBR_FIX[a] ?? a;
}

export function nameToAbbr(fullName: string): string {
  const name = (fullName ?? "").trim();
  const direct = NAME_TO_ABBR[name];
  if (direct) return direct;
  return (name || "UNK").slice(0, 3).toUpperCase();
}

export function abbrToName(abbr: string): string {
  const a = normAbbr(abbr);
  return ABBR_TO_NAME[a] ?? a;
}
