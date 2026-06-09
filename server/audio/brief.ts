// Sharp Desk brief generator. Tone: conversational — a sharp talking to a fellow
// sharp at the bar, not a robot reading a stat sheet. Uses Claude when a key is
// set; otherwise produces a deterministic template brief from the pick numbers.
//
// Everything the voice will say is humanized at build time:
//  - Natural time/date: "Tonight at six forty-one PM Eastern", "Tomorrow …".
//  - Numbers spelled as English words (spellNumber / spellMoneyLine / spellPercent
//    / spellUnits) — no digits or symbols reach the voice.
//  - Stat acronyms spelled in full every time (spellAcronym) — no "FIP", no
//    "that's X" wrapper, no double-comma stutter.
//  - The closing-line-value line is phrased so a fair price reads naturally.

import { generate } from "../llm/claude";
import { spellAcronym, spellMoneyLine, spellNumber, spellPercent, spellUnits } from "./spell";
import type { BuiltPick } from "../sports/mlb/picksEngine";

const SYSTEM = `You are the Sharp Desk analyst for a sports-betting desk, briefing a fellow sharp.
Voice: conversational and confident, like two pros talking at the bar — plain, direct, never hype.
Never use the words "lock", "smash", "hammer", or any emoji.
Speak every number as English words, never digits: "fifty-one point two percent", "plus one ten", "one and a half units".
Never use stat abbreviations — say "fielding independent pitching", not "FIP"; "money line", not "ML".
Spell times out naturally ("six forty-one PM Eastern"). Lead with when the game is ("Tonight at …", "Tomorrow afternoon at …").
Say the team names exactly as given in the facts (the article is already correct — don't add or remove "the").
Cite the edge in percent, the recommended units, and where fair value sits versus the close.
Write 3-5 sentences of flowing prose for a spoken brief. No lists, no headers.`;

// Probability (0..1) → spoken percent, e.g. 0.512 → "fifty-one point two percent".
function spokenWinPct(p: number | null): string {
  return p === null ? "an unknown percent" : spellPercent(Math.round(p * 1000) / 10);
}

// Sport-specific vocabulary so the brief reads naturally per league. Drivers are
// already spelled out (no acronyms) and joined with single commas — the voice
// reads a clean list with one pause between items.
interface SportVoice {
  scoreUnit: string;    // runs / goals / points
  startLabel: string;   // first pitch / puck drop / tip-off
  drivers: string;      // spelled-out stat drivers
}
function sportVoice(sport: string): SportVoice {
  switch (sport) {
    case "nhl":
      return { scoreUnit: "goals", startLabel: "puck drop", drivers: "expected goals for percentage and goalie save percentage" };
    case "nba":
      return { scoreUnit: "points", startLabel: "tip-off", drivers: "offensive rating, defensive rating, and pace" };
    case "soccer":
      return { scoreUnit: "goals", startLabel: "kickoff", drivers: "expected goals and expected goals against" };
    default:
      return { scoreUnit: "runs", startLabel: "first pitch", drivers: "fielding independent pitching, weighted on-base average, and park factors" };
  }
}

// Decide the when-phrase. Uses the game's ET clock + date vs the current time:
//   same calendar day  → "Tonight"/"This afternoon" (by hour)
//   next calendar day  → "Tomorrow"
//   otherwise          → the weekday name.
export function whenPhrase(pick: BuiltPick, now: Date = new Date()): string {
  // gameTimeEt looks like "7:05 PM ET"; pull the hour + meridiem.
  const t = (pick.gameTimeEt ?? "").match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  const meridiem = t ? t[3].toUpperCase() : "PM";
  const hour12 = t ? Number(t[1]) : 7;
  const daypart = meridiem === "AM" || (meridiem === "PM" && hour12 === 12)
    ? "afternoon"
    : hour12 <= 5 && meridiem === "PM"
      ? "afternoon"
      : "tonight";

  // Day delta from now (ET calendar dates).
  const todayEt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  const gameDate = pick.gameDate;

  if (gameDate === todayEt) {
    return daypart === "afternoon" ? "This afternoon" : "Tonight";
  }
  // tomorrow?
  const tomorrow = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(now.getTime() + 86_400_000));
  if (gameDate === tomorrow) {
    return daypart === "afternoon" ? "Tomorrow afternoon" : "Tomorrow night";
  }
  // weekday name
  try {
    const wd = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long" })
      .format(new Date(gameDate + "T12:00:00Z"));
    return wd;
  } catch {
    return "Coming up";
  }
}

// "7:05 PM ET" → spoken "seven oh five PM Eastern". Keeps the meridiem token
// capitalized (per spec) and the timezone spelled out.
function spokenTime(gameTimeEt: string): string {
  const raw = (gameTimeEt ?? "").trim();
  if (!raw) return "game time";
  const m = raw.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) return raw.replace(/\bE[DS]?T\b/g, "Eastern");
  const h = Number(m[1]);
  const min = Number(m[2]);
  const meridiem = m[3] ? ` ${m[3].toUpperCase()}` : "";
  return `${spokenClock(h, min)}${meridiem} Eastern`;
}

// Spoken clock: 6:41 → "six forty-one", 7:05 → "seven oh five", 10:00 → "ten o'clock".
function spokenClock(h: number, min: number): string {
  const hourWord = spellNumber(h);
  if (min === 0) return `${hourWord} o'clock`;
  if (min < 10) return `${hourWord} oh ${spellNumber(min)}`;
  return `${hourWord} ${spellNumber(min)}`;
}

// Spoken team label. American-league teams (MLB/NHL/NBA/NFL/NCAAF/NCAAB) read
// naturally with a definite article — "the New York Yankees", "the Spurs".
// Soccer teams never take "the": national sides ("Argentina", "Jordan") and
// clubs ("Manchester United") both sound wrong with it, and a soccer pick can
// also be "Draw". Names that already start with "the" are left as-is.
export function teamLabel(name: string, sport: string): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return trimmed;
  if (sport === "soccer") return trimmed;
  if (/^the\s/i.test(trimmed)) return trimmed;
  return `the ${trimmed}`;
}

// Second-mention team name: drop the city, keep the nickname, then apply the
// sport's article rule. "New York Yankees" → "the Yankees"; "Boston Red Sox" →
// "the Red Sox" (keeps the two-word nickname); soccer names stay whole and
// article-free ("Manchester United", "Argentina").
function shortTeam(full: string, sport: string): string {
  const trimmed = (full ?? "").trim();
  if (sport === "soccer") return trimmed;
  const words = trimmed.split(/\s+/);
  if (words.length <= 1) return teamLabel(trimmed, sport);
  // Common two-word nicknames where the last two words belong together.
  const lastTwo = words.slice(-2).join(" ");
  const nickname = /^(Red Sox|White Sox|Blue Jays|Maple Leafs|Trail Blazers|Golden Knights)$/i.test(lastTwo)
    ? lastTwo
    : words[words.length - 1];
  return teamLabel(nickname, sport);
}

// Closing-line-value phrasing. The fair money line is the price beyond which a
// bet stops beating the close, so we frame it as a threshold rather than a
// target: "fair value sits at minus one oh five, so anything inside that beats
// the close."
function clvPhrase(fairMl: number | null): string {
  if (fairMl === null) return "We don't have a clean fair-value read on this one.";
  return `Fair value sits at ${spellMoneyLine(fairMl)}, so anything inside that beats the close.`;
}

// Spoken umpire note for MLB picks when the assigned plate umpire moves run
// scoring meaningfully (|adj| > 0.15 runs/game). Returns "" otherwise.
function umpirePhrase(pick: BuiltPick): string {
  if (pick.sport !== "mlb") return "";
  const adj = pick.umpireRunAdj ?? 0;
  const name = pick.umpireName ?? null;
  if (!name || Math.abs(adj) <= 0.15) return "";
  const surname = name.trim().split(/\s+/).slice(-1)[0] || name;
  const tenths = Math.round(Math.abs(adj) * 10) / 10;
  const dir = adj > 0 ? "a hitter-friendly zone, pushing scoring up" : "a tight zone that suppresses scoring";
  return `${surname} is behind the plate with ${dir} by about ${spellNumber(tenths)} runs a game.`;
}

// Build the deterministic spoken brief from pick fields. This is the canonical
// script: fully humanized, no digits, no acronyms, no double commas. The Claude
// path falls back to this when no key is set.
export function buildBriefScript(pick: BuiltPick, bankroll: number, now: Date = new Date()): string {
  const v = sportVoice(pick.sport);
  const when = whenPhrase(pick, now);
  const time = spokenTime(pick.gameTimeEt);

  const edgePct = pick.edgePp !== null ? spellPercent(Math.round(pick.edgePp * 10) / 10) : "an unknown percent";
  const stakePct = bankroll > 0 ? spellPercent(Math.round((pick.kellyStakeDollars / bankroll) * 1000) / 10) : "no percent";

  // Projected scores rounded to one decimal each so they read naturally and the
  // spoken total matches the sum a listener would tally (round, then add).
  const away = Math.round(pick.projAwayScore * 10) / 10;
  const home = Math.round(pick.projHomeScore * 10) / 10;
  const total = Math.round((away + home) * 10) / 10;

  // First mention uses the full team name with the sport's article; the repeat
  // reference drops the city and reads as "the Yankees" so the brief doesn't
  // sound like a stat sheet. Soccer names stay article-free throughout.
  const awayLabel = teamLabel(pick.awayTeamFull, pick.sport);
  const homeLabel = teamLabel(pick.homeTeamFull, pick.sport);
  const pickFull = teamLabel(pick.pickTeamFull, pick.sport);
  const pickShort = shortTeam(pick.pickTeamFull, pick.sport);

  const sentences: string[] = [
    `${when} at ${time}, ${awayLabel} at ${homeLabel}.`,
    `We've got ${pickFull} at ${spokenWinPct(pick.pickWinProb)} to win, and the market is only pricing them at ${spokenWinPct(pick.pickImpliedProb)} — that's a ${edgePct} edge, and it is coming from ${v.drivers}.`,
    `Projected ${v.scoreUnit} land around ${spellNumber(away)} to ${spellNumber(home)}, total near ${spellNumber(total)}.`,
    pick.phantomEdge
      ? `I'm passing on this one — the edge is a mirage off thin data, not a real number.`
      : `So we're on ${pickShort} on the money line at ${spellMoneyLine(pick.pickMl)}, ${spellUnits(pick.units)}, about ${stakePct} of the roll.`,
    clvPhrase(pick.fairMl),
  ];

  const ump = umpirePhrase(pick);
  if (ump) sentences.splice(3, 0, ump);

  // Spell any stat acronyms the team names or drivers may still carry, then
  // collapse any incidental double commas/spaces into a single clean pause.
  return tidy(spellAcronym(sentences.join(" ")));
}

// Collapse ",," / ", ," / repeated whitespace into a single clean separator.
function tidy(text: string): string {
  return text
    .replace(/\s*,(?:\s*,)+/g, ",")
    .replace(/\s+,/g, ",")
    .replace(/\s+/g, " ")
    .trim();
}

// Build the analyst brief. Tries Claude first, falls back to the template.
// Whichever path runs, the output is acronym-spelled before return.
export async function generateBrief(
  pick: BuiltPick,
  bankroll: number,
  now: Date = new Date(),
): Promise<string> {
  const v = sportVoice(pick.sport);
  const when = whenPhrase(pick, now);
  const away = Math.round(pick.projAwayScore * 10) / 10;
  const home = Math.round(pick.projHomeScore * 10) / 10;
  const facts = [
    `Sport: ${pick.sport.toUpperCase()}`,
    `When: ${when}`,
    `Time: ${spokenTime(pick.gameTimeEt)}`,
    `Matchup: ${teamLabel(pick.awayTeamFull, pick.sport)} at ${teamLabel(pick.homeTeamFull, pick.sport)}`,
    `Start cue: ${v.startLabel}`,
    `Key drivers to reference (already spelled out, say them as-is): ${v.drivers}`,
    `Pick: ${teamLabel(pick.pickTeamFull, pick.sport)} money line at ${spellMoneyLine(pick.pickMl)} (${pick.pickBook ?? "best book"})`,
    `Model win probability: ${spokenWinPct(pick.pickWinProb)}`,
    `Market-implied probability: ${spokenWinPct(pick.pickImpliedProb)}`,
    `Edge: ${pick.edgePp !== null ? spellPercent(Math.round(pick.edgePp * 10) / 10) : "unknown"}`,
    `Recommended size: ${spellUnits(pick.units)}`,
    `Tier: ${pick.verdictTier}, confidence ${spellNumber(pick.confidence)} out of ninety-nine`,
    `Fair value / closing line: ${spellMoneyLine(pick.fairMl)}`,
    `Projected ${v.scoreUnit}: away ${spellNumber(away)}, home ${spellNumber(home)}, total ${spellNumber(Math.round((away + home) * 10) / 10)}`,
    ...(umpirePhrase(pick) ? [`Umpire note (work in naturally): ${umpirePhrase(pick)}`] : []),
  ].join("\n");

  const text = await generate(SYSTEM, `Write the spoken brief for this pick:\n${facts}`);
  if (!text) return buildBriefScript(pick, bankroll, now);
  return tidy(spellAcronym(text));
}

// Back-compat alias: the deterministic template brief is the canonical script.
export const templateBrief = buildBriefScript;
