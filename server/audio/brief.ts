// Sharp Desk Analyst brief generator. Tone: calm, institutional, quantitative,
// never hype (§12). Uses Claude Opus with extended thinking when a key is set;
// otherwise produces a deterministic template brief from the pick numbers so
// the audio path works end-to-end without credentials.

import { generate } from "../llm/claude";
import type { BuiltPick } from "../sports/mlb/picksEngine";

const SYSTEM = `You are the Sharp Desk Analyst for an institutional sports-betting desk.
Voice: calm, quantitative, precise. Never use the words "lock", "smash", "hammer", or any emoji.
Always cite the edge in percentage points, the recommended flat units, the stake as a percent of bankroll, and a CLV target.
Write 3-5 sentences of flowing prose suitable for a spoken brief. No lists, no headers.`;

function pct(p: number | null): string {
  return p === null ? "n/a" : `${(p * 100).toFixed(1)}%`;
}

function fmtLine(ml: number | null): string {
  if (ml === null) return "n/a";
  return ml > 0 ? `+${ml}` : `${ml}`;
}

// Sport-specific vocabulary so the brief reads naturally per league.
interface SportVoice {
  scoreUnit: string; // runs / goals / points
  startLabel: string; // first pitch / puck drop / tip-off
  matchupLabel: string; // starting pitchers / starting goalies / efficiency
  drivers: string; // the stat drivers the desk leans on
}
function sportVoice(sport: string): SportVoice {
  switch (sport) {
    case "nhl":
      return { scoreUnit: "goals", startLabel: "Puck drop", matchupLabel: "starting goalies", drivers: "expected-goals share and goalie save percentage" };
    case "nba":
      return { scoreUnit: "points", startLabel: "Tip-off", matchupLabel: "team efficiency", drivers: "offensive rating, pace, and opponent defensive rating" };
    default:
      return { scoreUnit: "runs", startLabel: "First pitch", matchupLabel: "starting pitchers", drivers: "FIP, team OPS, and park factors" };
  }
}

// Deterministic fallback brief built purely from pick fields.
export function templateBrief(pick: BuiltPick, bankroll: number): string {
  const v = sportVoice(pick.sport);
  const edge = pick.edgePp !== null ? `${pick.edgePp.toFixed(1)}` : "n/a";
  const stakePct = bankroll > 0 ? ((pick.kellyStakeDollars / bankroll) * 100).toFixed(1) : "0";
  const clvTarget = fmtLine(pick.fairMl);
  const sentences = [
    `${pick.awayTeamFull} at ${pick.homeTeamFull}, ${pick.gameTimeEt}.`,
    `The model has ${pick.pickTeamFull} at ${pct(pick.pickWinProb)} against a market-implied ${pct(pick.pickImpliedProb)}, a ${edge} percentage point edge, leaning on ${v.drivers}.`,
    `Projected ${v.scoreUnit}: ${pick.projAwayScore} to ${pick.projHomeScore}, a total near ${pick.expectedTotal}.`,
    pick.phantomEdge
      ? `No play — the edge here is a pricing artifact from missing data, so we pass.`
      : `Recommending ${pick.units} flat units on ${pick.pickTeam} money line at ${fmtLine(pick.pickMl)}, ${stakePct} percent of bankroll.`,
    `CLV target: ${clvTarget}.`,
  ];
  return sentences.join(" ");
}

// Build the analyst brief. Tries Claude first, falls back to the template.
export async function generateBrief(pick: BuiltPick, bankroll: number): Promise<string> {
  const v = sportVoice(pick.sport);
  const facts = [
    `Sport: ${pick.sport.toUpperCase()}`,
    `Matchup: ${pick.matchup}`,
    `${v.startLabel}: ${pick.gameTimeEt}`,
    `Key drivers to reference: ${v.drivers}`,
    `Pick: ${pick.pickTeamFull} money line at ${fmtLine(pick.pickMl)} (${pick.pickBook ?? "best book"})`,
    `Model win prob: ${pct(pick.pickWinProb)}`,
    `Market-implied prob: ${pct(pick.pickImpliedProb)}`,
    `Edge: ${pick.edgePp ?? "n/a"} pp`,
    `EV per $100: ${pick.evPer100}`,
    `Recommended units: ${pick.units} (stake $${pick.kellyStakeDollars})`,
    `Tier: ${pick.verdictTier}, confidence ${pick.confidence}`,
    `Fair line / CLV target: ${fmtLine(pick.fairMl)}`,
    `Projected ${v.scoreUnit}: away ${pick.projAwayScore}, home ${pick.projHomeScore}, total ${pick.expectedTotal}`,
  ].join("\n");

  const text = await generate(SYSTEM, `Write the spoken brief for this pick:\n${facts}`);
  return text ?? templateBrief(pick, bankroll);
}
