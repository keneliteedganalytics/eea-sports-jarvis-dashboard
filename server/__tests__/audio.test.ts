// Audio brief + TTS sanitizer tests. Verifies conversational phrasing, natural
// time/date, first-mention acronym expansion, and the §11 TTS number rules.
// Run: tsx server/__tests__/audio.test.ts

import assert from "node:assert/strict";

import { sanitizeForTTS } from "../audio/sanitizer";
import { expandAcronyms } from "../audio/acronyms";
import { templateBrief, whenPhrase } from "../audio/brief";
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

console.log("audio brief + sanitizer");

// ── sanitizer: number rules ─────────────────────────────────────────
test("sanitizer: +1400 → plus fourteen hundred", () => {
  assert.match(sanitizeForTTS("at +1400 odds"), /plus fourteen hundred/);
});

test("sanitizer: -180 → minus one-eighty (one eighty)", () => {
  const out = sanitizeForTTS("juiced to -180");
  assert.match(out, /minus one eighty/);
});

test("sanitizer: 23.5% → twenty-three and a half percent", () => {
  const out = sanitizeForTTS("model has 23.5% edge");
  assert.match(out, /twenty-three and a half percent/);
});

test("sanitizer: 60% → sixty percent", () => {
  assert.match(sanitizeForTTS("win prob 60%"), /sixty percent/);
});

test("sanitizer: 3.0u → three units; 2.5u → two and a half units", () => {
  assert.match(sanitizeForTTS("size 3.0u"), /three units/);
  assert.match(sanitizeForTTS("size 2.5u"), /two and a half units/);
});

test("sanitizer: ML → money line, F5 → first five innings", () => {
  const out = sanitizeForTTS("take the ML and the F5");
  assert.match(out, /money line/);
  assert.match(out, /first five innings/);
});

test("sanitizer: 1H → first half, 1P → first period", () => {
  assert.match(sanitizeForTTS("the 1H total"), /first half/);
  assert.match(sanitizeForTTS("the 1P line"), /first period/);
});

test("sanitizer: time 7:05 PM ET → seven oh five PM Eastern", () => {
  const out = sanitizeForTTS("first pitch 7:05 PM ET");
  assert.match(out, /seven oh five PM Eastern/);
});

test("sanitizer: 10:00 PM ET no longer 'ten oh-oh' — reads o'clock", () => {
  const out = sanitizeForTTS("tip at 10:00 PM ET");
  assert.match(out, /ten o'clock PM Eastern/);
  assert.doesNotMatch(out, /oh oh/);
});

test("sanitizer: 1:35 PM Eastern → one thirty-five PM Eastern", () => {
  const out = sanitizeForTTS("1:35 PM ET");
  assert.match(out, /one thirty-five PM Eastern/);
});

// ── acronym expansion: first mention only ───────────────────────────
test("acronyms: FIP expanded on first mention, bare after", () => {
  const out = expandAcronyms("FIP is great, and FIP again, plus xG.");
  // first FIP expands
  assert.match(out, /FIP, that's Fielding Independent Pitching/);
  // count expansions of "Fielding Independent Pitching" === 1
  const n = (out.match(/Fielding Independent Pitching/g) ?? []).length;
  assert.equal(n, 1, `expected 1 expansion, got ${n}`);
  // xG also expands once
  assert.match(out, /xG, that's Expected Goals/);
});

test("acronyms: unknown tokens untouched", () => {
  const out = expandAcronyms("the QB threw it");
  assert.equal(out, "the QB threw it");
});

// ── brief: conversational + dated ───────────────────────────────────
function mlbPick(over: Partial<BuiltPick> = {}): BuiltPick {
  return {
    sport: "mlb",
    gameId: "g1",
    gameDate: "2026-06-08",
    gameTimeEt: "7:05 PM ET",
    venue: "",
    matchup: "Yankees @ Guardians",
    homeTeam: "CLE",
    awayTeam: "NYY",
    homeTeamFull: "Cleveland Guardians",
    awayTeamFull: "New York Yankees",
    pickSide: "home",
    pickTeam: "CLE",
    pickTeamFull: "Cleveland Guardians",
    pickType: "ML",
    pickMl: -120,
    pickBook: "DraftKings",
    pickWinProb: 0.6,
    pickImpliedProb: 0.52,
    fairMl: -150,
    edgePp: 8.0,
    evPer100: 5,
    confidence: 70,
    units: 3,
    kellyStakeDollars: 375,
    halfCut: false,
    phantomEdge: false,
    verdict: "PLAY",
    verdictTier: "EDGE",
    qualifies: true,
    projHomeScore: 5,
    projAwayScore: 4,
    expectedTotal: 9,
    ...(over as object),
  } as unknown as BuiltPick;
}

test("brief: same-day game → 'Tonight'", () => {
  const now = new Date("2026-06-08T18:00:00Z"); // 2pm ET June 8
  const phrase = whenPhrase(mlbPick(), now);
  assert.equal(phrase, "Tonight");
});

test("brief: next-day game → 'Tomorrow'", () => {
  const now = new Date("2026-06-07T18:00:00Z"); // June 7 ET
  const phrase = whenPhrase(mlbPick(), now);
  assert.match(phrase, /Tomorrow/);
});

test("brief: afternoon game → 'This afternoon'", () => {
  const now = new Date("2026-06-08T14:00:00Z");
  const phrase = whenPhrase(mlbPick({ gameTimeEt: "1:35 PM ET" }), now);
  assert.equal(phrase, "This afternoon");
});

test("brief: conversational template mentions team + units + edge, expands FIP", () => {
  const now = new Date("2026-06-08T18:00:00Z");
  const b = templateBrief(mlbPick(), 25000, now);
  assert.match(b, /Cleveland Guardians/);
  assert.match(b, /percentage point edge/);
  assert.match(b, /Fielding Independent Pitching/); // first-mention expansion
  // no "ET" literal — uses Eastern
  assert.doesNotMatch(b, /\bET\b/);
});

test("brief: fully sanitized version is speakable (no raw % or ET)", () => {
  const now = new Date("2026-06-08T18:00:00Z");
  const spoken = sanitizeForTTS(templateBrief(mlbPick(), 25000, now));
  assert.doesNotMatch(spoken, /\d%/);
  assert.doesNotMatch(spoken, /\bET\b/);
  assert.match(spoken, /percent/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
