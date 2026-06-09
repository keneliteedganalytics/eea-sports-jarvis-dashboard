// ESPN score-shape regression. The live-score widget went stale when ESPN
// rotated competitor.score between a numeric string ("3") and an object
// ({ value, displayValue }). parseEspnEvent must extract the canonical shape
// (homeScore, awayScore, state, completed, statusDetail) from both.
// Run: tsx server/__tests__/espn-scores.test.ts

import assert from "node:assert/strict";
import { parseEspnEvent } from "../adapters/espnLive";

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

console.log("espn score-shape parsing");

function event(homeScore: unknown, awayScore: unknown, type: Record<string, unknown>) {
  return {
    id: "401",
    date: "2026-06-08T23:00Z",
    competitions: [
      {
        status: { type },
        competitors: [
          { homeAway: "home", score: homeScore, team: { abbreviation: "PIT", displayName: "Pittsburgh Pirates" } },
          { homeAway: "away", score: awayScore, team: { abbreviation: "CHC", displayName: "Chicago Cubs" } },
        ],
      },
    ],
  };
}

// ── canonical shape: string scores (the long-standing ESPN format) ──
test("string scores parse to numbers (final)", () => {
  const g = parseEspnEvent(event("4", "2", { name: "STATUS_FINAL", state: "post", completed: true, shortDetail: "Final" }))!;
  assert.equal(g.home.score, 4);
  assert.equal(g.away.score, 2);
  assert.equal(g.completed, true);
  assert.equal(g.state, "post");
  assert.equal(g.statusDetail, "Final");
});

// ── ESPN rotation: object-form scores for a live game ──
test("object-form score { value } parses (live, mid-game)", () => {
  const g = parseEspnEvent(
    event({ value: 3, displayValue: "3" }, { value: 1, displayValue: "1" }, {
      name: "STATUS_IN_PROGRESS",
      state: "in",
      completed: false,
      shortDetail: "Top 5th",
    }),
  )!;
  assert.equal(g.home.score, 3);
  assert.equal(g.away.score, 1);
  assert.equal(g.completed, false);
  assert.equal(g.state, "in");
  assert.equal(g.statusDetail, "Top 5th");
});

// ── object-form with only displayValue still parses ──
test("object-form score with only displayValue parses", () => {
  const g = parseEspnEvent(
    event({ displayValue: "7" }, { displayValue: "5" }, { name: "STATUS_FINAL", completed: true }),
  )!;
  assert.equal(g.home.score, 7);
  assert.equal(g.away.score, 5);
});

// ── numeric scores (defensive) ──
test("numeric score parses directly", () => {
  const g = parseEspnEvent(event(6, 6, { name: "STATUS_IN_PROGRESS", state: "in" }))!;
  assert.equal(g.home.score, 6);
  assert.equal(g.away.score, 6);
});

// ── scheduled: missing scores → null, never NaN ──
test("scheduled game → null scores (no NaN leak)", () => {
  const g = parseEspnEvent(event(undefined, undefined, { name: "STATUS_SCHEDULED", state: "pre", completed: false }))!;
  assert.equal(g.home.score, null);
  assert.equal(g.away.score, null);
  assert.equal(g.state, "pre");
});

test("empty-string and garbage scores coerce to null, not NaN", () => {
  const g = parseEspnEvent(event("", { value: undefined, displayValue: "x" }, { name: "STATUS_SCHEDULED" }))!;
  assert.equal(g.home.score, null);
  assert.equal(g.away.score, null);
});

// ── state detection falls back to type.state when name is unknown ──
test("unknown status name with state='in' still maps to in-progress", () => {
  const g = parseEspnEvent(event("2", "0", { name: "STATUS_RAIN_DELAY", state: "in", completed: false }))!;
  assert.equal(g.state, "in");
  assert.equal(g.completed, false);
});

// ── canonical fields present (homeScore/awayScore/inning/status) ──
test("extracts the full canonical shape", () => {
  const g = parseEspnEvent(
    event({ value: 5 }, { value: 4 }, { name: "STATUS_IN_PROGRESS", state: "in", completed: false, shortDetail: "Bot 8th" }),
  )!;
  assert.equal(g.eventId, "401");
  assert.equal(g.home.abbreviation, "PIT");
  assert.equal(g.away.abbreviation, "CHC");
  assert.equal(g.home.score, 5);
  assert.equal(g.away.score, 4);
  assert.equal(g.statusDetail, "Bot 8th");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
