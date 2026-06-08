// Sharp Desk brief generator. Tone: conversational — a sharp talking to a fellow
// sharp at the bar, not a robot reading a stat sheet. Uses Claude when a key is
// set; otherwise produces a deterministic template brief from the pick numbers.
//
// Three rules drive readability (see audio.test.ts):
//  - Natural time/date: "Tonight at 7:05 PM Eastern", "Tomorrow afternoon at …".
//  - Acronyms expanded on FIRST mention only (FIP, xG, ORtg, …) via expandAcronyms.
//  - The final string is passed through sanitizeForTTS before it reaches the voice.

import { generate } from "../llm/claude";
import { expandAcronyms } from "./acronyms";
import type { BuiltPick } from "../sports/mlb/picksEngine";

const SYSTEM = `You are the Sharp Desk analyst for a sports-betting desk, briefing a fellow sharp.
Voice: conversational and confident, like two pros talking at the bar — plain, direct, never hype.
Never use the words "lock", "smash", "hammer", or any emoji.
Spell times out naturally ("7:05 PM Eastern", not "ET"). Lead with when the game is ("Tonight at …", "Tomorrow afternoon at …").
The FIRST time you use a stat acronym (FIP, xG, ORtg, SV%), say what it stands for once, then use the short form after.
Cite the edge in percentage points, the recommended units, and a closing-line-value target.
Write 3-5 sentences of flowing prose for a spoken brief. No lists, no headers.`;

function pct(p: number | null): string {
  return p === null ? "n/a" : `${(p * 100).toFixed(1)}%`;
}

function fmtLine(ml: number | null): string {
  if (ml === null) return "n/a";
  return ml > 0 ? `+${ml}` : `${ml}`;
}

// Sport-specific vocabulary so the brief reads naturally per league. The drivers
// strings deliberately include acronyms so first-mention expansion can fire.
interface SportVoice {
  scoreUnit: string;    // runs / goals / points
  startLabel: string;   // first pitch / puck drop / tip-off
  drivers: string;      // stat drivers, with acronyms
}
function sportVoice(sport: string): SportVoice {
  switch (sport) {
    case "nhl":
      return { scoreUnit: "goals", startLabel: "puck drop", drivers: "xGF% and goalie SV%" };
    case "nba":
      return { scoreUnit: "points", startLabel: "tip-off", drivers: "ORtg, DRtg, and Pace" };
    case "soccer":
      return { scoreUnit: "goals", startLabel: "kickoff", drivers: "xG and xGA" };
    default:
      return { scoreUnit: "runs", startLabel: "first pitch", drivers: "FIP, wOBA, and park factors" };
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

// "7:05 PM ET" → "7:05 PM Eastern" (sanitizer later spells the clock out).
function spokenTime(gameTimeEt: string): string {
  return (gameTimeEt ?? "").replace(/\bET\b/g, "Eastern").trim() || "game time";
}

// Deterministic fallback brief built purely from pick fields. Conversational.
export function templateBrief(pick: BuiltPick, bankroll: number, now: Date = new Date()): string {
  const v = sportVoice(pick.sport);
  const edge = pick.edgePp !== null ? `${pick.edgePp.toFixed(1)}` : "n/a";
  const stakePct = bankroll > 0 ? ((pick.kellyStakeDollars / bankroll) * 100).toFixed(1) : "0";
  const when = whenPhrase(pick, now);
  const time = spokenTime(pick.gameTimeEt);

  const sentences: string[] = [
    `${when} at ${time}, it's ${pick.awayTeamFull} at ${pick.homeTeamFull}.`,
    `We've got ${pick.pickTeamFull} at ${pct(pick.pickWinProb)} to win, and the market's only pricing them at ${pct(pick.pickImpliedProb)} — that's a ${edge} percentage point edge, and it's coming from ${v.drivers}.`,
    `Projected ${v.scoreUnit} land around ${pick.projAwayScore} to ${pick.projHomeScore}, total near ${pick.expectedTotal}.`,
    pick.phantomEdge
      ? `I'm passing on this one — the edge is a mirage off thin data, not a real number.`
      : `So we're on ${pick.pickTeamFull} on the money line at ${fmtLine(pick.pickMl)}, ${pick.units}u, about ${stakePct}% of the roll.`,
    `Closing-line-value target is ${fmtLine(pick.fairMl)}.`,
  ];
  // Expand acronyms on first mention, then return.
  return expandAcronyms(sentences.join(" "));
}

// Build the analyst brief. Tries Claude first, falls back to the template.
// Whichever path runs, the output is acronym-expanded before return.
export async function generateBrief(
  pick: BuiltPick,
  bankroll: number,
  now: Date = new Date(),
): Promise<string> {
  const v = sportVoice(pick.sport);
  const when = whenPhrase(pick, now);
  const facts = [
    `Sport: ${pick.sport.toUpperCase()}`,
    `When: ${when}`,
    `Time: ${spokenTime(pick.gameTimeEt)}`,
    `Matchup: ${pick.awayTeamFull} at ${pick.homeTeamFull}`,
    `Start cue: ${v.startLabel}`,
    `Key drivers to reference: ${v.drivers}`,
    `Pick: ${pick.pickTeamFull} money line at ${fmtLine(pick.pickMl)} (${pick.pickBook ?? "best book"})`,
    `Model win prob: ${pct(pick.pickWinProb)}`,
    `Market-implied prob: ${pct(pick.pickImpliedProb)}`,
    `Edge: ${pick.edgePp ?? "n/a"} pp`,
    `Recommended units: ${pick.units}`,
    `Tier: ${pick.verdictTier}, confidence ${pick.confidence}`,
    `Closing-line-value target: ${fmtLine(pick.fairMl)}`,
    `Projected ${v.scoreUnit}: away ${pick.projAwayScore}, home ${pick.projHomeScore}, total ${pick.expectedTotal}`,
  ].join("\n");

  const text = await generate(SYSTEM, `Write the spoken brief for this pick:\n${facts}`);
  if (!text) return templateBrief(pick, bankroll, now);
  return expandAcronyms(text);
}
