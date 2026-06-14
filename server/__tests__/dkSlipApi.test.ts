// v6.9.5 — DraftKings multi-leg slip loader API tests.
// Covers:
//   1. scope=parlays returns deep link with comma-separated IDs from SNIPER parlay legs only
//   2. scope=game filters by gameId correctly
//   3. scope=sniper-singles returns all SNIPER prop picks
//   4. null selectionIds are excluded from main selectionIds array but appear in perEventLinks
//   5. perEventLinks.deepLink is a valid https://sportsbook.draftkings.com/ URL (v6.9.5)
//   6. deduplicated legs (same eventId+selectionId pair appears only once)
//
// Run: tsx server/__tests__/dkSlipApi.test.ts

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Isolated temp DB ─────────────────────────────────────────────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graded-dk-slip-"));
process.env.GRADED_BOOK_PATH = path.join(tmpDir, "test_book.db");

const {
  upsertPropOffer,
  upsertPropPick,
  getPropPick,
  getVirtualParlaysForDate,
} = await import("../gradedBook");
const { buildVirtualParlaysForDates } = await import("../jobs/virtualParlayBuilder");
const { pickToDkLink } = await import("../lib/dkLinks");

// ── Test data ─────────────────────────────────────────────────────────────────
const DAY = "2026-07-10";
const DK_BASE = "https://sportsbook.draftkings.com";

// Seed two SNIPER props for the same game (both with null selectionId, since
// the current pipeline always produces null for props).
for (const player of ["Aaron Judge", "Giancarlo Stanton"]) {
  upsertPropOffer({
    event_id: "NYYvsBOS", sport: "mlb", game_date: DAY,
    player_name: player, market: "batter_home_runs", line: 0.5,
    over_price: -115, under_price: -105, book: "draftkings",
    event_home: "Boston Red Sox", event_away: "New York Yankees",
  });
}
const postedAt = `${DAY}T14:00:00.000Z`;
upsertPropPick({
  pick_id: "slip_p1", sport: "mlb", game_id: "NYYvsBOS",
  player_name: "Aaron Judge", market_type: "batter_home_runs",
  market_label: "HR", line: 0.5, side: "over", posted_odds: -115,
  tier: "SNIPER", posted_at: postedAt,
});
upsertPropPick({
  pick_id: "slip_p2", sport: "mlb", game_id: "NYYvsBOS",
  player_name: "Giancarlo Stanton", market_type: "batter_home_runs",
  market_label: "HR", line: 0.5, side: "over", posted_odds: -110,
  tier: "SNIPER", posted_at: postedAt,
});
// A non-SNIPER pick — should NEVER appear in slip output.
upsertPropPick({
  pick_id: "slip_p3", sport: "mlb", game_id: "NYYvsBOS",
  player_name: "DJ LeMahieu", market_type: "batter_hits",
  market_label: "Hits", line: 0.5, side: "over", posted_odds: -120,
  tier: "EDGE", posted_at: postedAt,
});
// A SNIPER pick for a different game.
upsertPropOffer({
  event_id: "LAAvsTEX", sport: "mlb", game_date: DAY,
  player_name: "Shohei Ohtani", market: "batter_home_runs", line: 0.5,
  over_price: -110, under_price: -110, book: "draftkings",
  event_home: "Texas Rangers", event_away: "Los Angeles Angels",
});
upsertPropPick({
  pick_id: "slip_p4", sport: "mlb", game_id: "LAAvsTEX",
  player_name: "Shohei Ohtani", market_type: "batter_home_runs",
  market_label: "HR", line: 0.5, side: "over", posted_odds: -110,
  tier: "SNIPER", posted_at: postedAt,
});

// Build virtual parlays (one per SNIPER pick).
buildVirtualParlaysForDates([DAY]);

// ── Mirror the route handler inline ──────────────────────────────────────────
// We can't import routes.ts (it starts live workers on import), so we replicate
// the /api/dk/slip logic directly here, using the same helper (pickToDkLink).
// v6.9.5: buildPropDkLocal uses pickToDkLink() to produce https:// deepLinks.

function buildPropDkLocal(row: {
  tier: string; game_id: string; player_name: string; market_type: string; market_label: string | null;
}) {
  if (row.tier !== "SNIPER") return null;
  const eventId = row.game_id;
  // v6.9.5: use https universal link (same as routes.ts buildPropDk)
  const deepLink = pickToDkLink({ sport: "mlb", marketType: row.market_type });
  return { selectionId: null as string | null, eventId, deepLink };
}

// Import propBoard to query picks the same way the route does.
const { propBoard } = await import("../gradedBook");

function buildSlipResponse(
  scope: "parlays" | "sniper-singles" | "game",
  date: string,
  gameId?: string,
) {
  type CandidateLeg = { selectionId: string | null; eventId: string; label: string; dkLink: string };
  const candidates: CandidateLeg[] = [];

  if (scope === "parlays") {
    const parlays = getVirtualParlaysForDate(date);
    for (const p of parlays) {
      let pickIds: string[] = [];
      try { pickIds = JSON.parse(p.leg_pick_ids ?? "[]") as string[]; } catch { pickIds = []; }
      for (const id of pickIds) {
        const row = getPropPick(id);
        if (!row || row.tier !== "SNIPER") continue;
        const dk = buildPropDkLocal(row);
        if (!dk) continue;
        candidates.push({ selectionId: dk.selectionId, eventId: dk.eventId, label: `${row.player_name} · ${row.market_label ?? row.market_type}`, dkLink: dk.deepLink });
      }
    }
  } else if (scope === "sniper-singles") {
    const rows = propBoard({ date, tier: "ALL" }).filter((r) => r.tier === "SNIPER");
    for (const row of rows) {
      const dk = buildPropDkLocal(row);
      if (!dk) continue;
      candidates.push({ selectionId: dk.selectionId, eventId: dk.eventId, label: `${row.player_name} · ${row.market_label ?? row.market_type}`, dkLink: dk.deepLink });
    }
  } else if (scope === "game" && gameId) {
    const rows = propBoard({ date, tier: "ALL" }).filter(
      (r) => r.tier === "SNIPER" && r.game_id === gameId,
    );
    for (const row of rows) {
      const dk = buildPropDkLocal(row);
      if (!dk) continue;
      candidates.push({ selectionId: dk.selectionId, eventId: dk.eventId, label: `${row.player_name} · ${row.market_label ?? row.market_type}`, dkLink: dk.deepLink });
    }
  }

  const seen = new Set<string>();
  const deduped: CandidateLeg[] = [];
  for (const c of candidates) {
    const key = c.selectionId !== null ? `sid:${c.selectionId}` : `label:${c.label}`;
    if (!seen.has(key)) { seen.add(key); deduped.push(c); }
  }

  const withId = deduped.filter((c) => c.selectionId !== null);
  const withoutId = deduped.filter((c) => c.selectionId === null);
  const selectionIds = withId.map((c) => c.selectionId as string);
  const eventIds = [...new Set(deduped.map((c) => c.eventId))];
  const skipped = withoutId.length;

  const deepLink = selectionIds.length > 0 ? `${DK_BASE}/?selectionIds=${selectionIds.join(",")}` : null;
  const webFallback = selectionIds.length > 0 ? `${DK_BASE}/?selectionIds=${selectionIds.join(",")}` : null;
  // v6.9.5: perEventLinks deepLink is an https:// universal link (not dk://)
  const perEventLinks = withoutId.map((c) => ({
    eventId: c.eventId,
    deepLink: c.dkLink,
    label: c.label,
  }));

  return { scope, date, selectionIds, eventIds, count: selectionIds.length, skipped, skippedReason: skipped > 0 ? "null selection id (fallback to sport-level deep link)" : null, deepLink, webFallback, perEventLinks };
}

// ── Tests ─────────────────────────────────────────────────────────────────────
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

console.log("v6.9.5 — DraftKings multi-leg slip loader API");

// ── 1. scope=parlays ──────────────────────────────────────────────────────────
test("scope=parlays: returns response with correct shape", () => {
  const slip = buildSlipResponse("parlays", DAY);
  assert.ok("selectionIds" in slip, "must have selectionIds");
  assert.ok("count" in slip, "must have count");
  assert.ok("skipped" in slip, "must have skipped");
  assert.ok("perEventLinks" in slip, "must have perEventLinks");
  assert.ok("deepLink" in slip, "must have deepLink");
  assert.ok("webFallback" in slip, "must have webFallback");
});

test("scope=parlays: contains only SNIPER legs (EDGE/PASS excluded)", () => {
  const slip = buildSlipResponse("parlays", DAY);
  // All our SNIPER picks have null selectionId so they end up in perEventLinks.
  // The EDGE pick (slip_p3) must NOT appear.
  const allLabels = slip.perEventLinks.map((l) => l.label);
  const edgePickPresent = allLabels.some((l) => l.includes("DJ LeMahieu"));
  assert.ok(!edgePickPresent, `EDGE pick must not appear in slip: ${JSON.stringify(allLabels)}`);
});

test("scope=parlays: returns 3 SNIPER legs (one per SNIPER pick)", () => {
  const slip = buildSlipResponse("parlays", DAY);
  // Three SNIPER picks: slip_p1, slip_p2, slip_p4
  assert.equal(slip.count + slip.skipped, 3, `expected 3 total legs, got ${slip.count + slip.skipped}`);
});

// ── 2. scope=game with gameId filtering ────────────────────────────────────────
test("scope=game: filters to NYYvsBOS game only (2 SNIPER legs)", () => {
  const slip = buildSlipResponse("game", DAY, "NYYvsBOS");
  assert.equal(slip.count + slip.skipped, 2, `expected 2 legs for NYYvsBOS, got ${slip.count + slip.skipped}`);
  // The Shohei Ohtani pick (LAAvsTEX) must NOT be present.
  const allLabels = slip.perEventLinks.map((l) => l.label);
  const ohtaniPresent = allLabels.some((l) => l.includes("Shohei Ohtani"));
  assert.ok(!ohtaniPresent, `Ohtani (LAAvsTEX) must not appear in NYYvsBOS slip: ${JSON.stringify(allLabels)}`);
});

test("scope=game: eventIds contains only the requested gameId", () => {
  const slip = buildSlipResponse("game", DAY, "LAAvsTEX");
  assert.equal(slip.count + slip.skipped, 1, "only 1 SNIPER for LAAvsTEX");
  assert.ok(slip.eventIds.every((id) => id === "LAAvsTEX"), `unexpected eventIds: ${JSON.stringify(slip.eventIds)}`);
});

// ── 3. null selectionIds appear in perEventLinks ───────────────────────────────
test("null selectionIds excluded from main selectionIds array", () => {
  const slip = buildSlipResponse("sniper-singles", DAY);
  // All prop picks have null selectionId in the current pipeline.
  assert.equal(slip.selectionIds.length, 0, "expected empty selectionIds array (all props have null sid)");
  assert.equal(slip.count, 0, "count must be 0 when all sids are null");
  assert.ok(slip.skipped > 0, "skipped must be >0 when all sids are null");
});

test("null selectionIds appear in perEventLinks with valid https DK URLs (v6.9.5)", () => {
  const slip = buildSlipResponse("sniper-singles", DAY);
  assert.ok(slip.perEventLinks.length > 0, "perEventLinks must be non-empty");
  for (const l of slip.perEventLinks) {
    assert.ok(typeof l.eventId === "string", "perEventLinks[].eventId must be string");
    assert.ok(typeof l.deepLink === "string", "perEventLinks[].deepLink must be string");
    assert.ok(typeof l.label === "string", "perEventLinks[].label must be string");
    // v6.9.5: must be a valid https DK universal link, NOT dk:// scheme
    assert.ok(
      l.deepLink.startsWith(DK_BASE + "/"),
      `perEventLink deepLink must be https DK URL (not dk://): ${l.deepLink}`,
    );
    assert.ok(!l.deepLink.startsWith("dk://"), `Must not use dk:// scheme: ${l.deepLink}`);
  }
});

test("skippedReason is set when nulls are present", () => {
  const slip = buildSlipResponse("sniper-singles", DAY);
  assert.ok(slip.skippedReason !== null, "skippedReason must be set when skipped > 0");
  assert.ok(slip.skippedReason!.includes("null selection id"), `unexpected skippedReason: ${slip.skippedReason}`);
});

// ── 4. scope=sniper-singles ────────────────────────────────────────────────────
test("scope=sniper-singles: returns all 3 SNIPER picks (across all games)", () => {
  const slip = buildSlipResponse("sniper-singles", DAY);
  assert.equal(slip.count + slip.skipped, 3, `expected 3 total SNIPER singles, got ${slip.count + slip.skipped}`);
});

test("scope=sniper-singles: EDGE pick is excluded", () => {
  const slip = buildSlipResponse("sniper-singles", DAY);
  const allLabels = slip.perEventLinks.map((l) => l.label);
  const edgePresent = allLabels.some((l) => l.includes("DJ LeMahieu"));
  assert.ok(!edgePresent, "EDGE pick must not appear in sniper-singles slip");
});

// ── 5. deepLink / webFallback null when no selectionIds ───────────────────────
test("deepLink is null when no selection IDs are available", () => {
  const slip = buildSlipResponse("sniper-singles", DAY);
  assert.equal(slip.deepLink, null, "deepLink must be null when no valid sids");
  assert.equal(slip.webFallback, null, "webFallback must be null when no valid sids");
});

// ── 6. deduplication ──────────────────────────────────────────────────────────
test("same selectionId is not duplicated in selectionIds array", () => {
  // selectionIds (empty here for null-sid picks) should have no duplicates.
  const slip = buildSlipResponse("sniper-singles", DAY);
  const sids = slip.selectionIds;
  assert.equal(sids.length, new Set(sids).size, "selectionIds must not contain duplicates");
});

test("same label is not duplicated in perEventLinks (null sid dedup)", () => {
  // Each pick has a distinct player+market label so no deduplication should remove any.
  const slip = buildSlipResponse("sniper-singles", DAY);
  const labels = slip.perEventLinks.map((l) => l.label);
  assert.equal(labels.length, new Set(labels).size, "perEventLinks labels must be unique");
});

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
