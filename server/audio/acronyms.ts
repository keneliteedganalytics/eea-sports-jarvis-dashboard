// First-mention acronym expansion for spoken briefs. The first time an acronym
// appears in a brief we expand it ("FIP, that's Fielding Independent Pitching"),
// then use the bare acronym afterward. Per-brief state lives in an Expander.

export const ACRONYM_GLOSSARY: Record<string, string> = {
  // MLB
  FIP: "Fielding Independent Pitching",
  xFIP: "expected Fielding Independent Pitching",
  wOBA: "Weighted On-base Average",
  "BB/9": "walks per nine innings",
  "K/9": "strikeouts per nine innings",
  "ERA+": "ERA adjusted for park and league",
  BABIP: "Batting Average on Balls In Play",
  ISO: "Isolated Power",
  SIERA: "Skill-Interactive ERA",
  // NHL
  "SV%": "Save Percentage",
  GAA: "Goals Against Average",
  Corsi: "Corsi, a shot-attempt differential metric",
  Fenwick: "Fenwick, unblocked shot attempts",
  PDO: "PDO, shooting plus save percentage",
  "xGF%": "Expected Goals For Percentage",
  HDCF: "High Danger Chances For",
  // NBA
  ORtg: "Offensive Rating",
  DRtg: "Defensive Rating",
  "eFG%": "Effective Field Goal Percentage",
  "TS%": "True Shooting Percentage",
  "USG%": "Usage Rate",
  Pace: "Pace, possessions per game",
  NetRtg: "Net Rating",
  // Soccer
  xG: "Expected Goals",
  xGA: "Expected Goals Against",
  PPDA: "Passes Per Defensive Action",
  HxG: "Home Expected Goals",
};

// Build a regex that matches any glossary key as a whole token. Keys with
// special chars (/, +, %) are escaped; longest keys first to avoid partials.
function buildPattern(keys: string[]): RegExp {
  const escaped = keys
    .slice()
    .sort((a, b) => b.length - a.length)
    .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(?<![A-Za-z0-9])(${escaped.join("|")})(?![A-Za-z0-9])`, "g");
}

// Expand the first occurrence of each known acronym; leave later ones bare.
// Returns a new string. The seen-set makes expansion idempotent per brief.
export function expandAcronyms(
  text: string,
  glossary: Record<string, string> = ACRONYM_GLOSSARY,
): string {
  const keys = Object.keys(glossary);
  if (keys.length === 0) return text;
  const pattern = buildPattern(keys);
  const seen = new Set<string>();
  return text.replace(pattern, (match) => {
    if (seen.has(match)) return match;
    seen.add(match);
    const full = glossary[match];
    if (!full) return match;
    // Phrasing reads naturally aloud: "FIP, that's Fielding Independent Pitching,"
    return `${match}, that's ${full},`;
  });
}
