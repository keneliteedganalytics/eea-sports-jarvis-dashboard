// v6.9.5 — DraftKings one-tap deep-link unit tests.
// Covers:
//   1. buildDkPayload — SNIPER gets dk object; EDGE/RECON/PASS get null.
//   2. All deepLinks are https://sportsbook.draftkings.com/ universal links (v6.9.5).
//   3. API-supplied https deepLinks are used verbatim.
//   4. Fallback with null selectionIds: uses https DK sport-level page.
//   5. Serializer: propBoard dk field present on SNIPER, absent on non-SNIPER.
// No network required — all inputs are synthetic fixtures.
// Run: tsx server/__tests__/dkDeepLink.test.ts

import assert from "node:assert/strict";
import { buildDkPayload } from "../sports/mlb/picksEngine";
import { pickToDkLink } from "../lib/dkLinks";
import type { OddsEvent } from "../adapters/oddsApi";

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

console.log("v6.9.5 — DraftKings one-tap deep-link");

const DK_BASE = "https://sportsbook.draftkings.com";

// ── Helper: build a synthetic OddsEvent carrying DK home/away selection IDs ──
// v6.9.5: dkHomeDeepLink / dkAwayDeepLink are now https:// URLs produced by
// the updated extractDkData() via pickToDkLink().

function makeOddsEvent(opts: {
  dkHomeSelectionId?: string | null;
  dkAwaySelectionId?: string | null;
  dkHomeDeepLink?: string | null;
  dkAwayDeepLink?: string | null;
  dkEventId?: string | null;
  // Set to true to explicitly pass null for dkEventId (bypassing the ?? default)
  nullDkEventId?: boolean;
} = {}): OddsEvent {
  const dkHomeSelectionId = opts.dkHomeSelectionId !== undefined ? opts.dkHomeSelectionId : "sel_home_999";
  const dkAwaySelectionId = opts.dkAwaySelectionId !== undefined ? opts.dkAwaySelectionId : "sel_away_888";
  // v6.9.5: adapter now produces https:// fallback links via pickToDkLink().
  const homeDeepLink = opts.dkHomeDeepLink !== undefined
    ? opts.dkHomeDeepLink
    : `${DK_BASE}/leagues/baseball/mlb`;
  const awayDeepLink = opts.dkAwayDeepLink !== undefined
    ? opts.dkAwayDeepLink
    : `${DK_BASE}/leagues/baseball/mlb`;
  return {
    eventId: "odds_event_abc123",
    startIso: "2026-06-15T17:10:00Z",
    homeTeam: "NYY",
    awayTeam: "BOS",
    homeTeamFull: "New York Yankees",
    awayTeamFull: "Boston Red Sox",
    books: [],
    spread: { homeLine: -1.5, homePrice: 150, awayLine: 1.5, awayPrice: -170, book: "draftkings" },
    total: { line: 8.5, overPrice: -110, underPrice: -110, book: "draftkings" },
    rawBookmakers: [],
    dkEventId: opts.nullDkEventId ? null : (opts.dkEventId !== undefined ? opts.dkEventId : "odds_event_abc123"),
    dkHomeSelectionId,
    dkAwaySelectionId,
    dkHomeDeepLink: homeDeepLink,
    dkAwayDeepLink: awayDeepLink,
  };
}

// ── 1. buildDkPayload: tier gating ───────────────────────────────────────────

test("SNIPER home pick returns dk payload with home selectionId", () => {
  const ev = makeOddsEvent();
  const dk = buildDkPayload(ev, "SNIPER", "home");
  assert.ok(dk !== null, "expected non-null dk on SNIPER");
  assert.equal(dk!.eventId, "odds_event_abc123");
  assert.equal(dk!.selectionId, "sel_home_999");
  // v6.9.5: deepLink is always a valid DK https URL
  assert.ok(dk!.deepLink.startsWith(DK_BASE + "/"), `deepLink must be https DK URL: ${dk!.deepLink}`);
});

test("SNIPER away pick returns dk payload with away selectionId", () => {
  const ev = makeOddsEvent();
  const dk = buildDkPayload(ev, "SNIPER", "away");
  assert.ok(dk !== null, "expected non-null dk on SNIPER away");
  assert.equal(dk!.selectionId, "sel_away_888");
  assert.ok(dk!.deepLink.startsWith(DK_BASE + "/"), `deepLink must be https DK URL: ${dk!.deepLink}`);
});

test("EDGE pick returns null (not enriched)", () => {
  const ev = makeOddsEvent();
  const dk = buildDkPayload(ev, "EDGE", "home");
  assert.equal(dk, null, "EDGE should not get dk payload");
});

test("RECON pick returns null", () => {
  const ev = makeOddsEvent();
  const dk = buildDkPayload(ev, "RECON", "away");
  assert.equal(dk, null, "RECON should not get dk payload");
});

test("PASS pick returns null", () => {
  const ev = makeOddsEvent();
  const dk = buildDkPayload(ev, "PASS", "home");
  assert.equal(dk, null, "PASS should not get dk payload");
});

// ── 2. Null OddsEvent / missing dkEventId ────────────────────────────────────

test("null oddsEvent returns null even for SNIPER", () => {
  const dk = buildDkPayload(null, "SNIPER", "home");
  assert.equal(dk, null, "null oddsEvent → null dk");
});

test("oddsEvent with null dkEventId returns null for SNIPER", () => {
  const ev = makeOddsEvent({ nullDkEventId: true });
  const dk = buildDkPayload(ev, "SNIPER", "home");
  assert.equal(dk, null, "null dkEventId → null dk");
});

// ── 3. API-supplied https deep links used verbatim ───────────────────────────

test("API-supplied https homeDeepLink is used verbatim when present", () => {
  const ev = makeOddsEvent({ dkHomeDeepLink: `${DK_BASE}/event/27734567?selectionIds=777` });
  const dk = buildDkPayload(ev, "SNIPER", "home");
  assert.ok(dk !== null);
  assert.equal(dk!.deepLink, `${DK_BASE}/event/27734567?selectionIds=777`);
});

test("API-supplied https awayDeepLink is used for away picks", () => {
  const ev = makeOddsEvent({ dkAwayDeepLink: `${DK_BASE}/event/27734567?selectionIds=888` });
  const dk = buildDkPayload(ev, "SNIPER", "away");
  assert.ok(dk !== null);
  assert.equal(dk!.deepLink, `${DK_BASE}/event/27734567?selectionIds=888`);
});

// ── 4. Fallback when no API selection IDs (graceful degradation) ─────────────

test("SNIPER pick with null selectionIds falls back to https DK sport page", () => {
  // v6.9.5: adapter produces https:// fallback URLs via pickToDkLink().
  const ev = makeOddsEvent({
    dkHomeSelectionId: null,
    dkAwaySelectionId: null,
    // Simulate adapter output: no outcome.link → pickToDkLink({ sport: "mlb" })
    dkHomeDeepLink: `${DK_BASE}/leagues/baseball/mlb`,
    dkAwayDeepLink: `${DK_BASE}/leagues/baseball/mlb`,
  });
  const dk = buildDkPayload(ev, "SNIPER", "home");
  assert.ok(dk !== null);
  assert.equal(dk!.selectionId, null);
  // Falls back to https DK league page (NOT dk:// scheme)
  assert.ok(dk!.deepLink.startsWith(DK_BASE + "/"), `deepLink must be https DK URL: ${dk!.deepLink}`);
  assert.ok(!dk!.deepLink.startsWith("dk://"), `Must not use dk:// scheme: ${dk!.deepLink}`);
});

// ── 5. Props board serializer helper (buildPropDk logic) ─────────────────────
// v6.9.5: buildPropDk now calls pickToDkLink() — deepLink is always a https DK URL.

function buildPropDkInline(row: { tier: string; game_id: string; player_name: string; market_type: string }) {
  if (row.tier !== "SNIPER") return null;
  const eventId = row.game_id;
  // Mirror the updated routes.ts buildPropDk() logic
  const deepLink = pickToDkLink({ sport: "mlb", marketType: row.market_type });
  return { selectionId: null, eventId, deepLink };
}

test("propBoard serializer: SNIPER prop gets dk payload with https URL", () => {
  const row = { tier: "SNIPER", game_id: "game_abc", player_name: "Aaron Judge", market_type: "batter_home_runs" };
  const dk = buildPropDkInline(row);
  assert.ok(dk !== null, "SNIPER prop should have dk payload");
  assert.equal(dk!.eventId, "game_abc");
  // v6.9.5: deepLink is a https DK URL (props page) — not dk:// scheme
  assert.ok(dk!.deepLink.startsWith(DK_BASE + "/"), `deepLink must be https DK URL: ${dk!.deepLink}`);
  assert.ok(dk!.deepLink.includes("player-props"), `deepLink should point to props page: ${dk!.deepLink}`);
  assert.ok(!dk!.deepLink.startsWith("dk://"), `Must not use dk:// scheme: ${dk!.deepLink}`);
});

test("propBoard serializer: EDGE prop returns null", () => {
  const row = { tier: "EDGE", game_id: "game_abc", player_name: "Aaron Judge", market_type: "batter_hits" };
  const dk = buildPropDkInline(row);
  assert.equal(dk, null, "EDGE prop should not have dk payload");
});

test("propBoard serializer: PASS prop returns null", () => {
  const row = { tier: "PASS", game_id: "game_abc", player_name: "Mookie Betts", market_type: "batter_total_bases" };
  const dk = buildPropDkInline(row);
  assert.equal(dk, null, "PASS prop should not have dk payload");
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
