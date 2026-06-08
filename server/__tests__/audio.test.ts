// Audio brief tests. Verifies the spoken-English helpers (spellNumber,
// spellMoneyLine, spellPercent, spellUnits, spellAcronym), the conversational
// buildBriefScript template (no digits, no acronyms, no double commas), and the
// downstream TTS sanitizer's number rules.
// Run: tsx server/__tests__/audio.test.ts

import assert from "node:assert/strict";

import { sanitizeForTTS } from "../audio/sanitizer";
import {
  spellNumber,
  spellMoneyLine,
  spellPercent,
  spellUnits,
  spellAcronym,
} from "../audio/spell";
import { buildBriefScript, templateBrief, whenPhrase } from "../audio/brief";
import type { BuiltPick } from "../sports/mlb/picksEngine";

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err as Error).message}`);
  }
}

console.log("audio brief + spell helpers + sanitizer");

// ── spellNumber: decimals spoken naturally ──────────────────────────
test("spellNumber: 5.4 → five point four", () => {
  assert.equal(spellNumber(5.4), "five point four");
});
test("spellNumber: 51.2 → fifty-one point two", () => {
  assert.equal(spellNumber(51.2), "fifty-one point two");
});
test("spellNumber: 45.9 → forty-five point nine", () => {
  assert.equal(spellNumber(45.9), "forty-five point nine");
});
test("spellNumber: 7.8 → seven point eight", () => {
  assert.equal(spellNumber(7.8), "seven point eight");
});
test("spellNumber: 14 → fourteen (no trailing point)", () => {
  assert.equal(spellNumber(14), "fourteen");
});
test("spellNumber: 7.0 collapses to seven", () => {
  assert.equal(spellNumber(7.0), "seven");
});
test("spellNumber: 5.38 rounds to one decimal → five point four", () => {
  assert.equal(spellNumber(5.38), "five point four");
});

// ── spellMoneyLine: American odds grouped words ─────────────────────
test("spellMoneyLine: +110 → plus one ten", () => {
  assert.equal(spellMoneyLine(110), "plus one ten");
});
test("spellMoneyLine: -105 → minus one oh five", () => {
  assert.equal(spellMoneyLine(-105), "minus one oh five");
});
test("spellMoneyLine: -180 → minus one eighty", () => {
  assert.equal(spellMoneyLine(-180), "minus one eighty");
});
test("spellMoneyLine: +1400 → plus fourteen hundred", () => {
  assert.equal(spellMoneyLine(1400), "plus fourteen hundred");
});
test("spellMoneyLine: -150 → minus one fifty", () => {
  assert.equal(spellMoneyLine(-150), "minus one fifty");
});
test("spellMoneyLine: null → even money", () => {
  assert.equal(spellMoneyLine(null), "even money");
});

// ── spellPercent ────────────────────────────────────────────────────
test("spellPercent: 51.2 → fifty-one point two percent", () => {
  assert.equal(spellPercent(51.2), "fifty-one point two percent");
});
test("spellPercent: 2.3 → two point three percent", () => {
  assert.equal(spellPercent(2.3), "two point three percent");
});
test("spellPercent: 60 → sixty percent", () => {
  assert.equal(spellPercent(60), "sixty percent");
});

// ── spellUnits ──────────────────────────────────────────────────────
test("spellUnits: 1.5 → one and a half units", () => {
  assert.equal(spellUnits(1.5), "one and a half units");
});
test("spellUnits: 1 → one unit", () => {
  assert.equal(spellUnits(1), "one unit");
});
test("spellUnits: 3 → three units", () => {
  assert.equal(spellUnits(3), "three units");
});
test("spellUnits: 2.5 → two and a half units", () => {
  assert.equal(spellUnits(2.5), "two and a half units");
});

// ── spellAcronym: full spelling, every occurrence, no wrapper ───────
test("spellAcronym: FIP → fielding independent pitching (no 'that's')", () => {
  const out = spellAcronym("the FIP edge");
  assert.match(out, /fielding independent pitching/);
  assert.doesNotMatch(out, /that's/);
  assert.doesNotMatch(out, /\bFIP\b/);
});
test("spellAcronym: ML → money line, CLV → closing line value", () => {
  const out = spellAcronym("take the ML, watch CLV");
  assert.match(out, /money line/);
  assert.match(out, /closing line value/);
});
test("spellAcronym: every occurrence spelled, not just first", () => {
  const out = spellAcronym("FIP here and FIP there");
  const n = (out.match(/fielding independent pitching/g) ?? []).length;
  assert.equal(n, 2, `expected 2 expansions, got ${n}`);
});
test("spellAcronym: sport codes NHL/NBA/MLB kept as letters", () => {
  const out = spellAcronym("the NBA and NHL slates");
  assert.match(out, /\bNBA\b/);
  assert.match(out, /\bNHL\b/);
});

// ── sanitizer: downstream number rules still hold ───────────────────
test("sanitizer: +1400 → plus fourteen hundred", () => {
  assert.match(sanitizeForTTS("at +1400 odds"), /plus fourteen hundred/);
});
test("sanitizer: -180 → minus one eighty", () => {
  assert.match(sanitizeForTTS("juiced to -180"), /minus one eighty/);
});
test("sanitizer: 60% → sixty percent", () => {
  assert.match(sanitizeForTTS("win prob 60%"), /sixty percent/);
});

// ── brief: conversational, fully humanized ──────────────────────────
function mlbPick(over: Partial<BuiltPick> = {}): BuiltPick {
  return {
    sport: "mlb",
    gameId: "g1",
    gameDate: "2026-06-08",
    gameTimeEt: "6:41 PM ET",
    venue: "",
    matchup: "Yankees @ Guardians",
    homeTeam: "CLE",
    awayTeam: "NYY",
    homeTeamFull: "Cleveland Guardians",
    awayTeamFull: "New York Yankees",
    pickSide: "away",
    pickTeam: "NYY",
    pickTeamFull: "New York Yankees",
    pickType: "ML",
    pickMl: 110,
    pickBook: "DraftKings",
    pickWinProb: 0.512,
    pickImpliedProb: 0.459,
    fairMl: -105,
    edgePp: 5.38,
    evPer100: 5,
    confidence: 70,
    units: 1.5,
    kellyStakeDollars: 575,
    halfCut: false,
    phantomEdge: false,
    verdict: "PLAY",
    verdictTier: "EDGE",
    qualifies: true,
    projHomeScore: 3.46,
    projAwayScore: 4.34,
    expectedTotal: 7.8,
    ...(over as object),
  } as unknown as BuiltPick;
}

test("brief: NYY @ CLE acceptance — spoken numbers & spelled drivers", () => {
  const now = new Date("2026-06-08T18:00:00Z"); // ~2pm ET June 8
  const b = buildBriefScript(mlbPick(), 25000, now);
  assert.match(b, /Tonight at six forty-one PM Eastern/);
  assert.match(b, /New York Yankees at Cleveland Guardians/);
  assert.match(b, /fifty-one point two percent to win/);
  assert.match(b, /forty-five point nine percent/);
  assert.match(b, /five point four percent edge/);
  assert.match(b, /fielding independent pitching, weighted on-base average, and park factors/);
  assert.match(b, /four point three to three point five/);
  assert.match(b, /total near seven point eight/);
  assert.match(b, /on the Yankees on the money line at plus one ten/);
  assert.match(b, /one and a half units/);
  assert.match(b, /Fair value sits at minus one oh five, so anything inside that beats the close/);
});

test("brief: no digits anywhere in the spoken script", () => {
  const now = new Date("2026-06-08T18:00:00Z");
  const b = buildBriefScript(mlbPick(), 25000, now);
  assert.doesNotMatch(b, /\d/, `found a digit in: ${b}`);
});

test("brief: no acronyms (FIP/wOBA/ML/pp/u) and no raw % in the script", () => {
  const now = new Date("2026-06-08T18:00:00Z");
  const b = buildBriefScript(mlbPick(), 25000, now);
  assert.doesNotMatch(b, /\bFIP\b/);
  assert.doesNotMatch(b, /\bwOBA\b/);
  assert.doesNotMatch(b, /\bML\b/);
  assert.doesNotMatch(b, /\bpp\b/);
  assert.doesNotMatch(b, /\d\s*%/);
  assert.doesNotMatch(b, /\bET\b/);
});

test("brief: no double-comma stutter", () => {
  const now = new Date("2026-06-08T18:00:00Z");
  const b = buildBriefScript(mlbPick(), 25000, now);
  assert.doesNotMatch(b, /,\s*,/, `double comma in: ${b}`);
});

test("brief: projected total is the rounded sum (4.3 + 3.5 = 7.8, not 7.81)", () => {
  const now = new Date("2026-06-08T18:00:00Z");
  const b = buildBriefScript(mlbPick(), 25000, now);
  assert.match(b, /total near seven point eight/);
  assert.doesNotMatch(b, /seven point eight one/);
});

test("brief: phantom-edge pick says it's passing", () => {
  const now = new Date("2026-06-08T18:00:00Z");
  const b = buildBriefScript(mlbPick({ phantomEdge: true }), 25000, now);
  assert.match(b, /passing on this one/);
});

test("brief: templateBrief is the buildBriefScript alias", () => {
  assert.equal(templateBrief, buildBriefScript);
});

// ── when-phrase still resolves naturally ────────────────────────────
test("brief: same-day game → 'Tonight'", () => {
  const now = new Date("2026-06-08T18:00:00Z");
  assert.equal(whenPhrase(mlbPick(), now), "Tonight");
});
test("brief: next-day game → 'Tomorrow'", () => {
  const now = new Date("2026-06-07T18:00:00Z");
  assert.match(whenPhrase(mlbPick(), now), /Tomorrow/);
});
test("brief: afternoon game → 'This afternoon'", () => {
  const now = new Date("2026-06-08T14:00:00Z");
  assert.equal(whenPhrase(mlbPick({ gameTimeEt: "1:35 PM ET" }), now), "This afternoon");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
