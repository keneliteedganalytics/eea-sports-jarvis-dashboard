// ESPN scoreboard parsing + team matching. parseEspnEvent maps a raw event into
// our normalized shape (scores, status, abbreviation/displayName); matchEvent
// pairs a pick to its event by abbreviation, with a displayName fallback.
// Run: tsx server/__tests__/espn.test.ts

import assert from "node:assert/strict";
import { parseEspnEvent, type EspnGame } from "../adapters/espnLive";
import { matchEvent, normTeamAbbr } from "../jobs/teamMatch";
import type { GradedPick } from "../gradedBook";

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

console.log("espn parse + team match");

function rawEvent(over: Record<string, unknown> = {}) {
  return {
    id: "401",
    date: "2026-06-08T23:00Z",
    competitions: [
      {
        status: { type: { name: "STATUS_FINAL", completed: true, shortDetail: "Final" } },
        competitors: [
          { homeAway: "home", score: "111", team: { abbreviation: "NY", displayName: "New York Knicks" } },
          { homeAway: "away", score: "115", team: { abbreviation: "SA", displayName: "San Antonio Spurs" } },
        ],
      },
    ],
    ...over,
  };
}

// ── parse: scores + status ──────────────────────────────────────────
test("parseEspnEvent: final scores + completed", () => {
  const g = parseEspnEvent(rawEvent())!;
  assert.equal(g.completed, true);
  assert.equal(g.state, "post");
  assert.equal(g.home.score, 111);
  assert.equal(g.away.score, 115);
  assert.equal(g.away.abbreviation, "SA");
});
test("parseEspnEvent: in-progress maps to 'in' and not completed", () => {
  const g = parseEspnEvent(
    rawEvent({
      competitions: [
        {
          status: { type: { name: "STATUS_IN_PROGRESS", completed: false, shortDetail: "Q3 4:20" } },
          competitors: [
            { homeAway: "home", score: "55", team: { abbreviation: "NY", displayName: "New York Knicks" } },
            { homeAway: "away", score: "60", team: { abbreviation: "SA", displayName: "San Antonio Spurs" } },
          ],
        },
      ],
    }),
  )!;
  assert.equal(g.completed, false);
  assert.equal(g.state, "in");
  assert.equal(g.statusDetail, "Q3 4:20");
});
test("parseEspnEvent: scheduled maps to 'pre' with null scores", () => {
  const g = parseEspnEvent(
    rawEvent({
      competitions: [
        {
          status: { type: { name: "STATUS_SCHEDULED", completed: false } },
          competitors: [
            { homeAway: "home", team: { abbreviation: "NY", displayName: "New York Knicks" } },
            { homeAway: "away", team: { abbreviation: "SA", displayName: "San Antonio Spurs" } },
          ],
        },
      ],
    }),
  )!;
  assert.equal(g.state, "pre");
  assert.equal(g.home.score, null);
});

// ── team match: abbreviation normalization ──────────────────────────
test("normTeamAbbr: ESPN WAS → our WSH, SFG → SF", () => {
  assert.equal(normTeamAbbr("WAS"), "WSH");
  assert.equal(normTeamAbbr("SFG"), "SF");
});

function pick(over: Partial<GradedPick> = {}): GradedPick {
  return {
    id: "g:ML:home", gameId: "g", sport: "nba", gameDate: "2026-06-08", gameTimeEt: "7:00 PM ET",
    matchup: "SAS @ NYK", homeTeam: "NYK", awayTeam: "SAS",
    homeTeamFull: "New York Knicks", awayTeamFull: "San Antonio Spurs",
    pickSide: "home", pickTeam: "NYK", pickTeamFull: "New York Knicks", pickType: "ML",
    pickLine: null, pickMl: -125, pickBook: "DK", tier: "EDGE", units: 1, stakeDollars: 375,
    pickWinProb: 0.6, pickImpliedProb: 0.55, edgePp: 5, evPer100: 4, confidence: 70, fairMl: -130,
    status: "pending", liveAwayScore: null, liveHomeScore: null, liveStatusDetail: null,
    finalAwayScore: null, finalHomeScore: null, result: null, pl: null, clvPct: null,
    gradedAt: null, createdAt: "", updatedAt: "",
    ...over,
  } as GradedPick;
}

const games: EspnGame[] = [parseEspnEvent(rawEvent())!];

test("matchEvent: matches by abbreviation (SA/NY ↔ SAS/NYK)", () => {
  const ev = matchEvent(pick(), games);
  assert.ok(ev, "expected a match");
  assert.equal(ev!.away.score, 115);
});
test("matchEvent: displayName fallback when abbreviations differ", () => {
  const oddGames: EspnGame[] = [
    parseEspnEvent(
      rawEvent({
        competitions: [
          {
            status: { type: { name: "STATUS_FINAL", completed: true } },
            competitors: [
              { homeAway: "home", score: "111", team: { abbreviation: "XXX", displayName: "New York Knicks" } },
              { homeAway: "away", score: "115", team: { abbreviation: "YYY", displayName: "San Antonio Spurs" } },
            ],
          },
        ],
      }),
    )!,
  ];
  const ev = matchEvent(pick(), oddGames);
  assert.ok(ev, "expected a displayName-based match");
});
test("matchEvent: no match returns null", () => {
  assert.equal(matchEvent(pick({ homeTeam: "BOS", awayTeam: "LAL", homeTeamFull: "Boston Celtics", awayTeamFull: "Los Angeles Lakers" }), games), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
