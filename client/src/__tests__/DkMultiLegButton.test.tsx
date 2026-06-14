// v6.9.3 — DK multi-leg slip button render tests.
// Verifies:
//   • "Load all SNIPER parlays" button renders markup correctly when >=2 legs.
//   • Button is hidden (empty) when < 2 legs.
//   • Skipped-note renders when skipped > 0.
//   • Per-game "Load all SNIPERs for this game" button renders when
//     isMobile=true + relatedSniperPropCount >= 1 + verdictTier=SNIPER.
//   • Per-game button is hidden on desktop (isMobile=false).
//   • Per-game button is hidden when relatedSniperPropCount = 0.
//
// Uses inline HTML rendering (same pattern as DraftKingsButton.test.tsx) —
// no DOM / jsdom needed.
// Run: TSX_TSCONFIG_PATH=./tsconfig.client-test.json tsx client/src/__tests__/DkMultiLegButton.test.tsx

import assert from "node:assert/strict";

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

console.log("v6.9.3 — DK multi-leg slip button");

// ── Helpers — mirror the component render logic ──────────────────────────────

interface SlipData {
  count: number;
  skipped: number;
  deepLink: string | null;
  webFallback: string | null;
}

/** Mirror the "Load all SNIPER parlays" button in Parlays.tsx */
function buildParlayButtonHtml(isMobile: boolean, slip: SlipData | null): string {
  if (!isMobile || !slip) return "";
  if (slip.count + slip.skipped < 2) return "";
  const legCount = slip.count + slip.skipped;
  let html = `<div data-testid="dk-load-all-parlays-wrapper">`;
  html += `<button type="button" data-testid="dk-load-all-parlays" style="background-color:#53D337" aria-label="Load all SNIPER parlays to DraftKings" class="flex w-full items-center justify-center gap-2 rounded-xl">`;
  html += `Load all SNIPER parlays to DraftKings<span>${legCount} legs</span>`;
  html += `</button>`;
  if (slip.skipped > 0) {
    html += `<p data-testid="dk-slip-skipped-note">${slip.skipped} pick${slip.skipped !== 1 ? "s" : ""} couldn\u2019t be auto-loaded \u2014 tap individual cards instead.</p>`;
  }
  html += `</div>`;
  return html;
}

/** Mirror the per-game "Load all SNIPERs for this game" button in PickCard.tsx */
function buildGameSlipButtonHtml(isMobile: boolean, verdictTier: string, relatedSniperPropCount: number, gameId: string): string {
  if (!isMobile || verdictTier !== "SNIPER" || relatedSniperPropCount < 1) return "";
  return `<button type="button" data-testid="dk-game-slip-${gameId}" style="background-color:#53D337" aria-label="Load all SNIPER picks for this game on DraftKings" class="flex w-full items-center justify-center gap-2 rounded-lg">Load all SNIPERs for this game</button>`;
}

/** Mirror the Home sniper-singles button in Home.tsx */
function buildHomeSniperButtonHtml(isMobile: boolean, slip: SlipData | null, sport: string): string {
  if (!isMobile || sport === "PROPS" || !slip) return "";
  if (slip.count + slip.skipped < 2) return "";
  const total = slip.count + slip.skipped;
  return `<button type="button" data-testid="dk-load-all-snipers" style="background-color:#53D337" aria-label="Load all ${total} SNIPERs to DraftKings">Load all ${total} SNIPERs to DK</button>`;
}

// ── Parlays page button tests ──────────────────────────────────────────────────

test("parlays button renders on mobile when 2+ legs exist", () => {
  const slip: SlipData = { count: 0, skipped: 3, deepLink: null, webFallback: null };
  const html = buildParlayButtonHtml(true, slip);
  assert.ok(html.includes('data-testid="dk-load-all-parlays"'), `button missing: ${html}`);
  assert.ok(html.includes("#53D337"), "button must use DK green");
  assert.ok(html.includes("3 legs"), `leg count missing: ${html}`);
});

test("parlays button hidden when < 2 legs", () => {
  const slip: SlipData = { count: 0, skipped: 1, deepLink: null, webFallback: null };
  assert.equal(buildParlayButtonHtml(true, slip), "", "should be empty for 1 leg");
  assert.equal(buildParlayButtonHtml(true, { count: 0, skipped: 0, deepLink: null, webFallback: null }), "", "should be empty for 0 legs");
});

test("parlays button hidden on desktop (isMobile=false)", () => {
  const slip: SlipData = { count: 2, skipped: 1, deepLink: "dk://bet?selectionIds=a,b", webFallback: "https://sportsbook.draftkings.com/" };
  assert.equal(buildParlayButtonHtml(false, slip), "", "hidden on desktop");
});

test("parlays button hidden when slip is null", () => {
  assert.equal(buildParlayButtonHtml(true, null), "", "hidden when no data");
});

test("skipped note renders when skipped > 0", () => {
  const slip: SlipData = { count: 1, skipped: 2, deepLink: "dk://bet?selectionIds=a", webFallback: null };
  const html = buildParlayButtonHtml(true, slip);
  assert.ok(html.includes('data-testid="dk-slip-skipped-note"'), `skipped note missing: ${html}`);
  assert.ok(html.includes("2 picks couldn"), `skipped count missing: ${html}`);
});

test("skipped note absent when skipped = 0", () => {
  const slip: SlipData = { count: 3, skipped: 0, deepLink: "dk://bet?selectionIds=a,b,c", webFallback: null };
  const html = buildParlayButtonHtml(true, slip);
  assert.ok(!html.includes("couldn\u2019t be auto-loaded"), "skipped note must not appear when skipped=0");
});

test("parlays button uses correct label text", () => {
  const slip: SlipData = { count: 2, skipped: 1, deepLink: "dk://bet?selectionIds=a,b", webFallback: null };
  const html = buildParlayButtonHtml(true, slip);
  assert.ok(html.includes("Load all SNIPER parlays to DraftKings"), `label missing: ${html}`);
});

// ── Per-game button tests ──────────────────────────────────────────────────────

test("game-slip button renders for mobile SNIPER with 1 related prop", () => {
  const html = buildGameSlipButtonHtml(true, "SNIPER", 1, "NYYvsBOS");
  assert.ok(html.includes('data-testid="dk-game-slip-NYYvsBOS"'), `button missing: ${html}`);
  assert.ok(html.includes("#53D337"), "must use DK green");
  assert.ok(html.includes("Load all SNIPERs for this game"), `label missing: ${html}`);
});

test("game-slip button renders for mobile SNIPER with 3 related props", () => {
  const html = buildGameSlipButtonHtml(true, "SNIPER", 3, "LAAvsTEX");
  assert.ok(html.length > 0, "should render with 3 related props");
});

test("game-slip button hidden when isMobile=false", () => {
  assert.equal(buildGameSlipButtonHtml(false, "SNIPER", 2, "game1"), "", "hidden on desktop");
});

test("game-slip button hidden when relatedSniperPropCount = 0", () => {
  assert.equal(buildGameSlipButtonHtml(true, "SNIPER", 0, "game1"), "", "hidden when no related props");
});

test("game-slip button hidden for EDGE tier even with related props", () => {
  assert.equal(buildGameSlipButtonHtml(true, "EDGE", 2, "game1"), "", "hidden for EDGE tier");
});

test("game-slip button hidden for RECON tier", () => {
  assert.equal(buildGameSlipButtonHtml(true, "RECON", 2, "game1"), "", "hidden for RECON tier");
});

test("game-slip button hidden for PASS tier", () => {
  assert.equal(buildGameSlipButtonHtml(true, "PASS", 2, "game1"), "", "hidden for PASS tier");
});

// ── Home sniper-singles button tests ──────────────────────────────────────────

test("home snipers button renders on mobile when 2+ total snipers", () => {
  const slip: SlipData = { count: 0, skipped: 4, deepLink: null, webFallback: null };
  const html = buildHomeSniperButtonHtml(true, slip, "ALL");
  assert.ok(html.includes('data-testid="dk-load-all-snipers"'), `button missing: ${html}`);
  assert.ok(html.includes("Load all 4 SNIPERs to DK"), `label missing: ${html}`);
});

test("home snipers button hidden on desktop", () => {
  const slip: SlipData = { count: 3, skipped: 1, deepLink: null, webFallback: null };
  assert.equal(buildHomeSniperButtonHtml(false, slip, "ALL"), "", "hidden on desktop");
});

test("home snipers button hidden when < 2 snipers", () => {
  const slip1: SlipData = { count: 0, skipped: 1, deepLink: null, webFallback: null };
  assert.equal(buildHomeSniperButtonHtml(true, slip1, "ALL"), "", "1 sniper → hidden");
  const slip0: SlipData = { count: 0, skipped: 0, deepLink: null, webFallback: null };
  assert.equal(buildHomeSniperButtonHtml(true, slip0, "ALL"), "", "0 snipers → hidden");
});

test("home snipers button hidden on PROPS tab", () => {
  const slip: SlipData = { count: 3, skipped: 1, deepLink: null, webFallback: null };
  assert.equal(buildHomeSniperButtonHtml(true, slip, "PROPS"), "", "hidden on PROPS tab");
});

test("home snipers button shows correct count (count + skipped)", () => {
  const slip: SlipData = { count: 2, skipped: 3, deepLink: "dk://bet?selectionIds=a,b", webFallback: null };
  const html = buildHomeSniperButtonHtml(true, slip, "MLB");
  assert.ok(html.includes("Load all 5 SNIPERs to DK"), `expected 5 in label: ${html}`);
});

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
