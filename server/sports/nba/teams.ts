// NBA team name ↔ tri-code mapping. Tri-codes follow standard NBA codes.

const NAME_TO_ABBR: Record<string, string> = {
  "Atlanta Hawks": "ATL",
  "Boston Celtics": "BOS",
  "Brooklyn Nets": "BKN",
  "Charlotte Hornets": "CHA",
  "Chicago Bulls": "CHI",
  "Cleveland Cavaliers": "CLE",
  "Dallas Mavericks": "DAL",
  "Denver Nuggets": "DEN",
  "Detroit Pistons": "DET",
  "Golden State Warriors": "GSW",
  "Houston Rockets": "HOU",
  "Indiana Pacers": "IND",
  "Los Angeles Clippers": "LAC",
  "LA Clippers": "LAC",
  "Los Angeles Lakers": "LAL",
  "Memphis Grizzlies": "MEM",
  "Miami Heat": "MIA",
  "Milwaukee Bucks": "MIL",
  "Minnesota Timberwolves": "MIN",
  "New Orleans Pelicans": "NOP",
  "New York Knicks": "NYK",
  "Oklahoma City Thunder": "OKC",
  "Orlando Magic": "ORL",
  "Philadelphia 76ers": "PHI",
  "Phoenix Suns": "PHX",
  "Portland Trail Blazers": "POR",
  "Sacramento Kings": "SAC",
  "San Antonio Spurs": "SAS",
  "Toronto Raptors": "TOR",
  "Utah Jazz": "UTA",
  "Washington Wizards": "WAS",
};

const ABBR_TO_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(NAME_TO_ABBR).map(([n, a]) => [a, n]),
);

export function nameToAbbr(fullName: string): string {
  const name = (fullName ?? "").trim();
  return NAME_TO_ABBR[name] ?? (name || "UNK").slice(0, 3).toUpperCase();
}

export function abbrToName(abbr: string): string {
  const a = (abbr ?? "").trim().toUpperCase();
  return ABBR_TO_NAME[a] ?? a;
}
