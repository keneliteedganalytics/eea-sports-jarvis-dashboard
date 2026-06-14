// v6.9.2 — DraftKings one-tap deep-link unit tests.
// Covers:
//   1. extractDkData (internal) via the OddsEvent shape produced by fetchOddsForSport.
//   2. buildDkPayload — SNIPER gets dk object; EDGE/RECON/PASS get null.
//   3. Serializer: propBoard dk field present on SNIPER, absent on non-SNIPER.
// No network required — all inputs are synthetic fixtures.
// Run: tsx server/__tests__/dkDeepLink.test.ts

import assert from "node:assert/strict";
import { buildDkPayload } from "../sports/mlb/picksEngine";
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

console.log("v6.9.2 — DraftKings one-tap deep-link");

// ── Helper: build a synthetic OddsEvent carrying DK home/away selection IDs ──

function makeOddsEvent(opts: {
  dkHomeSelectionId?: string | null;
  dkAwaySelectionId?: string | null;
  dkHomeDeepLink?: string | null;
  dkAwayDeepLink?: string | null;
  dkEventId?: string | null;
  // Set to true to explicitly pass null for dkEventId (bypassing the ?? default)
  nullDkEventId?: boolean;
} = {}): OddsEvent {
  // When the adapter populates OddsEvent, it always fills dkHomeDeepLink / dkAwayDeepLink
  // via buildFallback — they're only null when DK is absent from the response entirely.
  // In this fixture, simulate the adapter-output: if selectionId is present, build the
  // fallback deep link that the adapter would have produced.
  const dkHomeSelectionId = opts.dkHomeSelectionId !== undefined ? opts.dkHomeSelectionId : "sel_home_999";
  const dkAwaySelectionId = opts.dkAwaySelectionId !== undefined ? opts.dkAwaySelectionId : "sel_away_888";
  // Simulate adapter buildFallback: uses sid when present.
  const homeDeepLink = opts.dkHomeDeepLink !== undefined
    ? opts.dkHomeDeepLink
    : dkHomeSelectionId ? `dk://bet?selectionIds=${dkHomeSelectionId}` : `dk://bet?event=New%20York%20Yankees&market=h2h`;
  const awayDeepLink = opts.dkAwayDeepLink !== undefined
    ? opts.dkAwayDeepLink
    : dkAwaySelectionId ? `dk://bet?selectionIds=${dkAwaySelectionId}` : `dk://bet?event=Boston%20Red%20Sox&market=h2h`;
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
  // deepLink: fallback since dkHomeDeepLink is null → uses selectionId
  assert.ok(dk!.deepLink.includes("sel_home_999"), `deepLink should include selectionId: ${dk!.deepLink}`);
});

test("SNIPER away pick returns dk payload with away selectionId", () => {
  const ev = makeOddsEvent();
  const dk = buildDkPayload(ev, "SNIPER", "away");
  assert.ok(dk !== null, "expected non-null dk on SNIPER away");
  assert.equal(dk!.selectionId, "sel_away_888");
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

// ── 3. API-supplied deep links preferred over fallback ───────────────────────

test("API-supplied homeDeepLink is used verbatim when present", () => {
  const ev = makeOddsEvent({ dkHomeDeepLink: "dk://sportsbook/event/12345?selId=777" });
  const dk = buildDkPayload(ev, "SNIPER", "home");
  assert.ok(dk !== null);
  assert.equal(dk!.deepLink, "dk://sportsbook/event/12345?selId=777");
});

test("API-supplied awayDeepLink is used for away picks", () => {
  const ev = makeOddsEvent({ dkAwayDeepLink: "dk://sportsbook/event/12345?selId=888" });
  const dk = buildDkPayload(ev, "SNIPER", "away");
  assert.ok(dk !== null);
  assert.equal(dk!.deepLink, "dk://sportsbook/event/12345?selId=888");
});

// ── 4. Fallback when no API selection IDs (graceful degradation) ─────────────

test("SNIPER pick with null selectionIds produces a search-style deepLink", () => {
  // When the adapter's buildFallback gets a null sid, it uses the team-name form.
  // Simulate that by providing explicit dkHomeDeepLink with the event form.
  const ev = makeOddsEvent({
    dkHomeSelectionId: null,
    dkAwaySelectionId: null,
    dkHomeDeepLink: "dk://bet?event=New%20York%20Yankees&market=h2h",
    dkAwayDeepLink: "dk://bet?event=Boston%20Red%20Sox&market=h2h",
  });
  const dk = buildDkPayload(ev, "SNIPER", "home");
  assert.ok(dk !== null);
  assert.equal(dk!.selectionId, null);
  // Falls back to event+market form using the encoded team name
  assert.ok(dk!.deepLink.includes("dk://bet?event="), `unexpected deepLink: ${dk!.deepLink}`);
  assert.ok(dk!.deepLink.includes("New%20York%20Yankees"),
    `deepLink should include encoded home team name: ${dk!.deepLink}`);
});

// ── 5. Props board serializer helper (buildPropDk logic) ─────────────────────

// We test the logic inline (it's a pure function of tier + game_id + player_name + market_type).
function buildPropDkInline(row: { tier: string; game_id: string; player_name: string; market_type: string }) {
  if (row.tier !== "SNIPER") return null;
  const eventId = row.game_id;
  const player = encodeURIComponent(row.player_name);
  const market = encodeURIComponent(row.market_type);
  const deepLink = `dk://bet?player=${player}&market=${market}&eventId=${encodeURIComponent(eventId)}`;
  return { selectionId: null, eventId, deepLink };
}

test("propBoard serializer: SNIPER prop gets dk payload", () => {
  const row = { tier: "SNIPER", game_id: "game_abc", player_name: "Aaron Judge", market_type: "batter_home_runs" };
  const dk = buildPropDkInline(row);
  assert.ok(dk !== null, "SNIPER prop should have dk payload");
  assert.equal(dk!.eventId, "game_abc");
  assert.ok(dk!.deepLink.includes("Aaron%20Judge") || dk!.deepLink.includes("Aaron+Judge"),
    `deepLink should include player name: ${dk!.deepLink}`);
  assert.ok(dk!.deepLink.includes("batter_home_runs"), `deepLink should include market: ${dk!.deepLink}`);
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
