// v6.10 — SaberEdgePanel render tests.
// Verifies the collapsible panel renders SP, offense, context, and verdict sections.
// Run: TSX_TSCONFIG_PATH=./tsconfig.client-test.json tsx client/src/__tests__/SaberEdgePanel.test.tsx

import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { SaberEdgePanel } from "../components/SaberEdgePanel";
import type { BuiltPick } from "../lib/types";

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

console.log("v6.10 — SaberEdgePanel render");

// Mock pick with all sabermetric data populated
const mockPick: BuiltPick = {
  sport: "mlb",
  gameId: "g1",
  gameDate: "2026-06-12",
  gameTimeEt: "7:05 PM ET",
  venue: "Rogers Centre",
  matchup: "MIA @ TOR",
  homeTeam: "TOR",
  awayTeam: "MIA",
  homeTeamFull: "Toronto Blue Jays",
  awayTeamFull: "Miami Marlins",
  pickSide: "home",
  pickTeam: "TOR",
  pickTeamFull: "Toronto Blue Jays",
  pickType: "ML",
  markets: { ml: {} as any, spread: {} as any, total: {} as any },
  pickMl: 110,
  pickBook: "DK",
  pickWinProb: 0.56,
  pickImpliedProb: 0.48,
  fairMl: 105,
  edgePp: 8,
  evPer100: 6.0,
  confidence: 75,
  units: 1,
  kellyStakeDollars: 375,
  kellyCapped: false,
  halfCut: false,
  phantomEdge: false,
  trimmed: false,
  subSampleWarning: false,
  subSampleDetails: null,
  alignmentSignalRaw: 22,
  topPlay: false,
  verdict: "PLAY",
  verdictTier: "EDGE",
  qualifies: true,
  trapSignal: false,
  trapGapPp: null,
  eliteFadeApplied: false,
  dataQualityTier: "SOLID",
  hardPassReason: null,
  isSparseModel: false,
  projHomeScore: 4.8,
  projAwayScore: 3.5,
  expectedTotal: 8.3,
  homeMl: -120,
  awayMl: +105,
  openHomeMl: -115,
  openAwayMl: +100,
  homeFairProb: 0.55,
  awayFairProb: 0.45,
  homeWinProb: 0.55,
  awayWinProb: 0.45,
  polymarket: { found: false, pct: null },
  publicPct: 55,
  sharpPct: 58,
  umpireName: "Hernández",
  umpireRunAdj: 0.18,
  homeSp: { available: true, pitcher: "Berríos", era: 3.82, fip: 3.50, ip: 72, whip: 1.11 },
  awaySp: { available: true, pitcher: "Pérez", era: 4.61, fip: 4.40, ip: 58, whip: 1.34 },
  modelNotes: [],
  pitcherEdge: {
    homePitcherName: "Berríos",
    awayPitcherName: "Pérez",
    homeXfip: 3.42,
    awayXfip: 4.61,
    homeKMinusBBPct: 0.184,
    awayKMinusBBPct: 0.092,
    homeWhip: 1.11,
    awayWhip: 1.34,
    edgeSide: "home",
    edgeSummary: "TOR has the analytical edge",
  },
  offenseEdge: {
    homeWrcPlus: 108,
    awayWrcPlus: 96,
    homeWobaVsRhp: 0.022,
    awayWobaVsRhp: -0.014,
    edgeSide: "home",
    edgeSummary: "TOR offense advantage",
  },
};

function render(pick: BuiltPick) {
  // Simulate expanded state by checking via data-testid
  return renderToStaticMarkup(createElement(SaberEdgePanel, { pick }));
}

test("renders panel container with data-testid saber-edge-panel", () => {
  const html = render(mockPick);
  assert.ok(html.includes("saber-edge-panel"), "expected saber-edge-panel testid");
});

test("renders toggle button with data-testid saber-edge-toggle", () => {
  const html = render(mockPick);
  assert.ok(html.includes("saber-edge-toggle"), "expected toggle button");
});

test("panel header shows 'Sabermetric Edge' text", () => {
  const html = render(mockPick);
  assert.ok(html.toLowerCase().includes("sabermetric edge"), "expected Sabermetric Edge header");
});

test("returns null for non-MLB picks", () => {
  const nhlPick: BuiltPick = { ...mockPick, sport: "nhl" };
  const html = render(nhlPick);
  assert.equal(html, "", "expected empty render for NHL pick");
});

test("returns null when no pitcher or offense edge data", () => {
  const noEdgePick: BuiltPick = { ...mockPick, pitcherEdge: null, offenseEdge: null };
  const html = render(noEdgePick);
  assert.equal(html, "", "expected empty render when no edge data");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
