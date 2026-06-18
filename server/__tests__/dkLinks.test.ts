// v6.9.5 — Unit tests for pickToDkLink() and isPropMarket() helpers.
// Covers all branch cases:
//   1. API-supplied https deepLink is used as-is
//   2. dk:// deepLink (old format) is NOT used — falls back to sport-level page
//   3. No deepLink — falls back to sport-level page
//   4. Prop market detection adds ?category=odds&subcategory=player-props
//   5. All four sports produce correct league paths
//   6. Every returned URL starts with https://sportsbook.draftkings.com/
//
// Run: tsx server/__tests__/dkLinks.test.ts

import assert from "node:assert/strict";
import { pickToDkLink, isPropMarket } from "../lib/dkLinks";

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

const DK = "https://sportsbook.draftkings.com";

console.log("v6.9.5 — pickToDkLink() / isPropMarket()");

// ── isPropMarket ──────────────────────────────────────────────────────────────

test("isPropMarket: batter_ prefix → true", () => {
  assert.ok(isPropMarket("batter_hits"));
  assert.ok(isPropMarket("batter_home_runs"));
  assert.ok(isPropMarket("batter_total_bases"));
  assert.ok(isPropMarket("batter_strikeouts"));
});

test("isPropMarket: pitcher_ prefix → true", () => {
  assert.ok(isPropMarket("pitcher_strikeouts"));
  assert.ok(isPropMarket("pitcher_outs"));
});

test("isPropMarket: h2h / spreads / totals → false", () => {
  assert.ok(!isPropMarket("h2h"));
  assert.ok(!isPropMarket("spreads"));
  assert.ok(!isPropMarket("totals"));
});

test("isPropMarket: null / undefined → false", () => {
  assert.ok(!isPropMarket(null));
  assert.ok(!isPropMarket(undefined));
  assert.ok(!isPropMarket(""));
});

// ── Rule 1: API-supplied https deepLink is used verbatim ─────────────────────

test("valid https DK deepLink is returned as-is (game line)", () => {
  const url = `${DK}/event/27734567`;
  const result = pickToDkLink({ dk: { deepLink: url }, sport: "mlb" });
  assert.equal(result, url);
});

test("valid https DK deepLink with selectionIds is returned as-is", () => {
  const url = `${DK}/event/27734567?selectionIds=12345,67890`;
  const result = pickToDkLink({ dk: { deepLink: url }, sport: "mlb" });
  assert.equal(result, url);
});

test("valid https DK deepLink for leagues page is returned as-is", () => {
  const url = `${DK}/leagues/baseball/mlb`;
  const result = pickToDkLink({ dk: { deepLink: url }, sport: "mlb" });
  assert.equal(result, url);
});

// ── Rule 2: dk:// (old custom scheme) falls back to sport-level page ──────────

test("old dk:// deepLink is NOT used — falls back to sport-level page", () => {
  const result = pickToDkLink({
    dk: { deepLink: "dk://bet?selectionIds=sel_999" },
    sport: "mlb",
  });
  assert.ok(result.startsWith(DK + "/"), `URL must start with DK base: ${result}`);
  assert.ok(!result.startsWith("dk://"), `Must not use dk:// scheme: ${result}`);
});

test("old dk://event?id= falls back to sport-level page", () => {
  const result = pickToDkLink({
    dk: { deepLink: "dk://event?id=abc123" },
    sport: "mlb",
  });
  assert.ok(result.startsWith(DK + "/"), `URL must start with DK base: ${result}`);
  assert.ok(!result.startsWith("dk://"), `Must not use dk:// scheme: ${result}`);
});

// ── Rule 3: No deepLink → sport-level page fallback ───────────────────────────

test("null dk → sport-level MLB page", () => {
  const result = pickToDkLink({ sport: "mlb" });
  assert.equal(result, `${DK}/leagues/baseball/mlb`);
});

test("dk present but deepLink is null → sport-level MLB page", () => {
  const result = pickToDkLink({ dk: { deepLink: null }, sport: "mlb" });
  assert.equal(result, `${DK}/leagues/baseball/mlb`);
});

test("dk present but deepLink is undefined → sport-level MLB page", () => {
  const result = pickToDkLink({ dk: {}, sport: "mlb" });
  assert.equal(result, `${DK}/leagues/baseball/mlb`);
});

// ── Rule 4: Prop markets add ?category=odds&subcategory=player-props ──────────

test("batter prop market → player-props suffix", () => {
  const result = pickToDkLink({ sport: "mlb", marketType: "batter_hits" });
  assert.equal(result, `${DK}/leagues/baseball/mlb?category=odds&subcategory=player-props`);
});

test("pitcher prop market → player-props suffix", () => {
  const result = pickToDkLink({ sport: "mlb", marketType: "pitcher_strikeouts" });
  assert.equal(result, `${DK}/leagues/baseball/mlb?category=odds&subcategory=player-props`);
});

test("game line market → no suffix", () => {
  const result = pickToDkLink({ sport: "mlb", marketType: "h2h" });
  assert.equal(result, `${DK}/leagues/baseball/mlb`);
});

test("null marketType → no suffix", () => {
  const result = pickToDkLink({ sport: "mlb", marketType: null });
  assert.equal(result, `${DK}/leagues/baseball/mlb`);
});

// ── Rule 5: All sports produce correct league paths ───────────────────────────

test("mlb sport → baseball/mlb path", () => {
  const result = pickToDkLink({ sport: "mlb" });
  assert.equal(result, `${DK}/leagues/baseball/mlb`);
});

test("nhl sport → hockey/nhl path", () => {
  const result = pickToDkLink({ sport: "nhl" });
  assert.equal(result, `${DK}/leagues/hockey/nhl`);
});

test("nba sport → basketball/nba path", () => {
  const result = pickToDkLink({ sport: "nba" });
  assert.equal(result, `${DK}/leagues/basketball/nba`);
});

test("undefined sport → defaults to MLB path", () => {
  const result = pickToDkLink({});
  assert.equal(result, `${DK}/leagues/baseball/mlb`);
});

// ── Rule 6: Every returned URL starts with https://sportsbook.draftkings.com/ ─

test("all branches always return a valid DK https URL", () => {
  const cases = [
    pickToDkLink({ sport: "mlb" }),
    pickToDkLink({ sport: "nhl" }),
    pickToDkLink({ sport: "nba" }),
    pickToDkLink({ sport: "mlb", marketType: "batter_hits" }),
    pickToDkLink({ dk: { deepLink: "dk://bad" }, sport: "mlb" }),
    pickToDkLink({ dk: { deepLink: null }, sport: "nhl" }),
    pickToDkLink({ dk: { deepLink: `${DK}/event/12345` }, sport: "nba" }),
  ];
  for (const url of cases) {
    assert.ok(
      url.startsWith(`${DK}/`),
      `URL must start with ${DK}/: got ${url}`,
    );
  }
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
