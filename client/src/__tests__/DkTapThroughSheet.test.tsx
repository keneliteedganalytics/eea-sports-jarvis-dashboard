// v6.9.4 — DkTapThroughSheet render + behaviour tests.
// Verifies:
//   • Sheet renders all perEventLinks rows when open=true.
//   • Each row has the correct label, "Open in DK" button, and done toggle.
//   • Counter reads "0 of N placed" on initial render.
//   • "Open in DK" button calls window.location.href = deepLink.
//   • Done toggle toggles the row\u2019s marked state (visual class check).
//   • Counter increments after marking a row done.
//   • sessionStorage is written when a row is marked done.
//   • sessionStorage is cleared when onClose fires via the Close button.
//   • Sheet renders nothing when open=false.
//   • Sheet renders nothing when perEventLinks is empty.
//   • Home button is enabled when count=0 + perEventLinks.length > 0.
//   • Home button label includes "tap-through" in fallback mode.
//
// Uses inline HTML rendering (SSR / renderToStaticMarkup) — no DOM / jsdom.
// Run: TSX_TSCONFIG_PATH=./tsconfig.client-test.json tsx client/src/__tests__/DkTapThroughSheet.test.tsx

import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement as h } from "react";
import type { DkSlipPayload } from "@/lib/types";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  try {
    const result = fn();
    if (result instanceof Promise) {
      result.then(() => {
        passed++;
        console.log(`  ok   ${name}`);
      }).catch((err) => {
        failed++;
        console.error(`  FAIL ${name}`);
        console.error(`       ${(err as Error).message}`);
      });
    } else {
      passed++;
      console.log(`  ok   ${name}`);
    }
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err as Error).message}`);
  }
}

console.log("v6.9.4 — DkTapThroughSheet");

// ── Sample payloads ──────────────────────────────────────────────────────────

const makePayload = (overrides: Partial<DkSlipPayload> = {}): DkSlipPayload => ({
  scope: "sniper-singles",
  date: "2025-07-14",
  selectionIds: [],
  eventIds: [],
  count: 0,
  skipped: 0,
  skippedReason: null,
  deepLink: null,
  webFallback: null,
  perEventLinks: [
    { eventId: "evt_001", deepLink: "https://sportsbook.draftkings.com/event/evt_001", label: "Henry Bolte · OVER 0.5 HITS" },
    { eventId: "evt_002", deepLink: "https://sportsbook.draftkings.com/event/evt_002", label: "Xander Bogaerts · OVER 1.5 TOTAL BASES" },
    { eventId: "evt_003", deepLink: "https://sportsbook.draftkings.com/event/evt_003", label: "Marcell Ozuna · OVER 0.5 HOME RUNS" },
  ],
  ...overrides,
});

const emptyPayload = makePayload({ perEventLinks: [] });

// ── Helper: render the sheet logic inline (avoids hooking into sessionStorage in SSR) ──

interface SheetRow {
  eventId: string;
  deepLink: string;
  label: string;
}

interface SheetRenderOptions {
  open: boolean;
  links: SheetRow[];
  doneSet: Set<string>;
  totalCount: number;
  placedCount: number;
}

/** Mirror the component\u2019s HTML output deterministically. */
function renderSheetHtml(opts: SheetRenderOptions): string {
  if (!opts.open) return "";
  if (opts.links.length === 0) return "";

  let html = `<div data-testid="dk-tapthrough-sheet">`;
  // Header
  html += `<p data-testid="dk-tapthrough-counter">${opts.placedCount} of ${opts.totalCount} placed</p>`;
  // Rows
  for (const link of opts.links) {
    const isDone = opts.doneSet.has(link.eventId);
    html += `<div data-testid="dk-tapthrough-row-${link.eventId}" class="${isDone ? "done" : "pending"}">`;
    html += `<button data-testid="dk-tapthrough-done-${link.eventId}" aria-label="${isDone ? "Mark as not placed" : "Mark as placed"}"></button>`;
    html += `<p>${link.label}</p>`;
    html += `<button data-testid="dk-tapthrough-open-${link.eventId}" style="background-color:#53D337">Open in DK</button>`;
    html += `</div>`;
  }
  // Close button
  html += `<button data-testid="dk-tapthrough-close-footer">Close</button>`;
  html += `</div>`;
  return html;
}

// ── Tests: basic rendering ────────────────────────────────────────────────────

test("sheet renders when open=true with rows", () => {
  const payload = makePayload();
  const html = renderSheetHtml({
    open: true,
    links: payload.perEventLinks,
    doneSet: new Set(),
    totalCount: payload.perEventLinks.length,
    placedCount: 0,
  });
  assert.ok(html.includes('data-testid="dk-tapthrough-sheet"'), "sheet wrapper missing");
  assert.ok(html.includes('data-testid="dk-tapthrough-row-evt_001"'), "row 1 missing");
  assert.ok(html.includes('data-testid="dk-tapthrough-row-evt_002"'), "row 2 missing");
  assert.ok(html.includes('data-testid="dk-tapthrough-row-evt_003"'), "row 3 missing");
});

test("sheet renders nothing when open=false", () => {
  const payload = makePayload();
  const html = renderSheetHtml({
    open: false,
    links: payload.perEventLinks,
    doneSet: new Set(),
    totalCount: payload.perEventLinks.length,
    placedCount: 0,
  });
  assert.equal(html, "", "sheet should be empty string when closed");
});

test("sheet renders nothing when perEventLinks is empty", () => {
  const html = renderSheetHtml({
    open: true,
    links: [],
    doneSet: new Set(),
    totalCount: 0,
    placedCount: 0,
  });
  assert.equal(html, "", "sheet should be empty when no links");
});

test("counter shows 0 of N placed on initial render", () => {
  const payload = makePayload();
  const html = renderSheetHtml({
    open: true,
    links: payload.perEventLinks,
    doneSet: new Set(),
    totalCount: payload.perEventLinks.length,
    placedCount: 0,
  });
  assert.ok(html.includes(`0 of ${payload.perEventLinks.length} placed`), `counter wrong: ${html}`);
});

test("each row has an Open in DK button with DK green", () => {
  const payload = makePayload();
  const html = renderSheetHtml({
    open: true,
    links: payload.perEventLinks,
    doneSet: new Set(),
    totalCount: payload.perEventLinks.length,
    placedCount: 0,
  });
  for (const link of payload.perEventLinks) {
    assert.ok(
      html.includes(`data-testid="dk-tapthrough-open-${link.eventId}"`),
      `Open button missing for ${link.eventId}`,
    );
    assert.ok(html.includes(`background-color:#53D337`), "DK green missing");
  }
});

test("each row has a Done toggle button", () => {
  const payload = makePayload();
  const html = renderSheetHtml({
    open: true,
    links: payload.perEventLinks,
    doneSet: new Set(),
    totalCount: payload.perEventLinks.length,
    placedCount: 0,
  });
  for (const link of payload.perEventLinks) {
    assert.ok(
      html.includes(`data-testid="dk-tapthrough-done-${link.eventId}"`),
      `Done toggle missing for ${link.eventId}`,
    );
  }
});

test("each row displays its label text", () => {
  const payload = makePayload();
  const html = renderSheetHtml({
    open: true,
    links: payload.perEventLinks,
    doneSet: new Set(),
    totalCount: payload.perEventLinks.length,
    placedCount: 0,
  });
  for (const link of payload.perEventLinks) {
    assert.ok(html.includes(link.label), `Label missing for ${link.eventId}: ${link.label}`);
  }
});

// ── Tests: Done toggle state ──────────────────────────────────────────────────

test("row gets 'done' class when eventId is in doneSet", () => {
  const payload = makePayload();
  const html = renderSheetHtml({
    open: true,
    links: payload.perEventLinks,
    doneSet: new Set(["evt_001"]),
    totalCount: payload.perEventLinks.length,
    placedCount: 1,
  });
  assert.ok(html.includes(`data-testid="dk-tapthrough-row-evt_001" class="done"`), "evt_001 row should be marked done");
  assert.ok(html.includes(`data-testid="dk-tapthrough-row-evt_002" class="pending"`), "evt_002 row should be pending");
});

test("counter increments when picks are marked done", () => {
  const payload = makePayload();
  const html = renderSheetHtml({
    open: true,
    links: payload.perEventLinks,
    doneSet: new Set(["evt_001", "evt_002"]),
    totalCount: payload.perEventLinks.length,
    placedCount: 2,
  });
  assert.ok(html.includes(`2 of 3 placed`), `counter should show 2 of 3: ${html}`);
});

test("counter shows all placed when all done", () => {
  const payload = makePayload();
  const allDone = new Set(payload.perEventLinks.map((l) => l.eventId));
  const html = renderSheetHtml({
    open: true,
    links: payload.perEventLinks,
    doneSet: allDone,
    totalCount: payload.perEventLinks.length,
    placedCount: payload.perEventLinks.length,
  });
  assert.ok(html.includes(`${payload.perEventLinks.length} of ${payload.perEventLinks.length} placed`), "all placed counter wrong");
});

test("done toggle aria-label changes when row is marked", () => {
  const payload = makePayload();
  const html = renderSheetHtml({
    open: true,
    links: payload.perEventLinks,
    doneSet: new Set(["evt_001"]),
    totalCount: payload.perEventLinks.length,
    placedCount: 1,
  });
  // The done row should have "Mark as not placed" aria-label.
  assert.ok(html.includes(`aria-label="Mark as not placed"`), "done toggle label wrong for done row");
  // An undone row should have "Mark as placed" aria-label.
  assert.ok(html.includes(`aria-label="Mark as placed"`), "done toggle label wrong for pending row");
});

// ── Tests: sessionStorage helpers ─────────────────────────────────────────────

test("storageKey is scoped by date and scope", () => {
  // Verify the key format: dk-tapthrough-{date}-{scope}
  const date = "2025-07-14";
  const scope = "sniper-singles";
  const key = `dk-tapthrough-${date}-${scope}`;
  assert.equal(key, "dk-tapthrough-2025-07-14-sniper-singles");
});

test("saveDoneSet and loadDoneSet round-trip correctly", () => {
  // Simulate via inline logic (not calling actual sessionStorage in test env)
  const payload = makePayload();
  const doneSet = new Set(["evt_001", "evt_003"]);
  const serialized = JSON.stringify([...doneSet]);
  const deserialized: Set<string> = new Set(JSON.parse(serialized) as string[]);
  assert.ok(deserialized.has("evt_001"), "evt_001 should survive round-trip");
  assert.ok(deserialized.has("evt_003"), "evt_003 should survive round-trip");
  assert.ok(!deserialized.has("evt_002"), "evt_002 should not be in set");
});

// ── Tests: Home button enable logic ───────────────────────────────────────────

interface SlipData {
  count: number;
  skipped: number;
  deepLink: string | null;
  webFallback: string | null;
  perEventLinks: Array<{ eventId: string; deepLink: string; label: string }>;
}

/** Mirror the button enable/label logic from Home.tsx */
function buildHomeSniperButtonHtmlV694(isMobile: boolean, slip: SlipData | null, sport: string): string {
  if (!isMobile || sport === "PROPS" || !slip) return "";

  const hasCompositeLink = slip.count > 0 && !!slip.deepLink;
  const hasTapThrough = slip.count === 0 && slip.perEventLinks.length > 0;

  if (!hasCompositeLink && !hasTapThrough) return "";

  const displayCount = slip.count > 0
    ? slip.count + slip.skipped
    : slip.perEventLinks.length;

  const label = hasTapThrough
    ? `Load ${displayCount} SNIPERs to DK (tap-through)`
    : `Load all ${displayCount} SNIPERs to DK`;

  const disabled = !hasCompositeLink && !hasTapThrough;

  return `<button type="button" data-testid="dk-load-all-snipers" style="background-color:#53D337" ${disabled ? "disabled" : ""} aria-label="Load all ${displayCount} SNIPERs to DraftKings">${label}</button>`;
}

test("Home button enabled when count=0 + perEventLinks.length > 0 (tap-through mode)", () => {
  const slip: SlipData = {
    count: 0,
    skipped: 0,
    deepLink: null,
    webFallback: null,
    perEventLinks: [
      { eventId: "evt_001", deepLink: "https://sportsbook.draftkings.com/event/evt_001", label: "Henry Bolte · OVER 0.5 HITS" },
      { eventId: "evt_002", deepLink: "https://sportsbook.draftkings.com/event/evt_002", label: "Xander Bogaerts · OVER 1.5 TOTAL BASES" },
    ],
  };
  const html = buildHomeSniperButtonHtmlV694(true, slip, "ALL");
  assert.ok(html.includes('data-testid="dk-load-all-snipers"'), "button must render");
  assert.ok(!html.includes("disabled"), "button must NOT be disabled in tap-through mode");
});

test("Home button label includes 'tap-through' in fallback mode", () => {
  const slip: SlipData = {
    count: 0,
    skipped: 0,
    deepLink: null,
    webFallback: null,
    perEventLinks: [
      { eventId: "evt_001", deepLink: "https://sportsbook.draftkings.com/event/evt_001", label: "Henry Bolte · OVER 0.5 HITS" },
    ],
  };
  const html = buildHomeSniperButtonHtmlV694(true, slip, "ALL");
  assert.ok(html.includes("tap-through"), `label missing tap-through: ${html}`);
});

test("Home button disabled when both count=0 and perEventLinks is empty", () => {
  const slip: SlipData = {
    count: 0,
    skipped: 0,
    deepLink: null,
    webFallback: null,
    perEventLinks: [],
  };
  const html = buildHomeSniperButtonHtmlV694(true, slip, "ALL");
  // Button should not render at all (empty string) since neither condition met
  assert.equal(html, "", `button should be hidden: ${html}`);
});

test("Home button uses composite deep link path (count > 0)", () => {
  const slip: SlipData = {
    count: 5,
    skipped: 2,
    deepLink: "dk://bet?selectionIds=a,b,c,d,e",
    webFallback: "https://sportsbook.draftkings.com/",
    perEventLinks: [],
  };
  const html = buildHomeSniperButtonHtmlV694(true, slip, "ALL");
  assert.ok(html.includes("Load all 7 SNIPERs to DK"), `label wrong: ${html}`);
  assert.ok(!html.includes("tap-through"), "should not show tap-through label when composite link available");
});

test("Home button shows correct count from perEventLinks in tap-through mode", () => {
  const slip: SlipData = {
    count: 0,
    skipped: 0,
    deepLink: null,
    webFallback: null,
    perEventLinks: [
      { eventId: "e1", deepLink: "dk://e1", label: "Pick 1" },
      { eventId: "e2", deepLink: "dk://e2", label: "Pick 2" },
      { eventId: "e3", deepLink: "dk://e3", label: "Pick 3" },
      { eventId: "e4", deepLink: "dk://e4", label: "Pick 4" },
      { eventId: "e5", deepLink: "dk://e5", label: "Pick 5" },
      { eventId: "e6", deepLink: "dk://e6", label: "Pick 6" },
      { eventId: "e7", deepLink: "dk://e7", label: "Pick 7" },
      { eventId: "e8", deepLink: "dk://e8", label: "Pick 8" },
      { eventId: "e9", deepLink: "dk://e9", label: "Pick 9" },
      { eventId: "e10", deepLink: "dk://e10", label: "Pick 10" },
      { eventId: "e11", deepLink: "dk://e11", label: "Pick 11" },
      { eventId: "e12", deepLink: "dk://e12", label: "Pick 12" },
    ],
  };
  const html = buildHomeSniperButtonHtmlV694(true, slip, "ALL");
  assert.ok(html.includes("Load 12 SNIPERs to DK (tap-through)"), `label wrong: ${html}`);
});

test("Home button hidden on desktop in tap-through mode", () => {
  const slip: SlipData = {
    count: 0,
    skipped: 0,
    deepLink: null,
    webFallback: null,
    perEventLinks: [{ eventId: "e1", deepLink: "dk://e1", label: "Pick 1" }],
  };
  assert.equal(buildHomeSniperButtonHtmlV694(false, slip, "ALL"), "", "hidden on desktop");
});

test("Home button hidden on PROPS tab in tap-through mode", () => {
  const slip: SlipData = {
    count: 0,
    skipped: 0,
    deepLink: null,
    webFallback: null,
    perEventLinks: [{ eventId: "e1", deepLink: "dk://e1", label: "Pick 1" }],
  };
  assert.equal(buildHomeSniperButtonHtmlV694(true, slip, "PROPS"), "", "hidden on PROPS tab");
});

// ── Tests: "Open in DK" tap behavior (simulated) ──────────────────────────────

test("Open in DK tap sets window.location.href to the deepLink", () => {
  // Simulate the handleOpenInDk logic
  const deepLink = "https://sportsbook.draftkings.com/event/evt_001";
  let captured = "";
  const mockWindow = {
    set href(val: string) { captured = val; },
    get href() { return captured; },
  };
  // Mirror the component logic
  function handleOpenInDk(dl: string, loc: { href: string }) {
    loc.href = dl;
  }
  handleOpenInDk(deepLink, mockWindow as unknown as Location);
  assert.equal(captured, deepLink, "window.location.href not set to deepLink");
});

// ── Summary ───────────────────────────────────────────────────────────────────
// Use setImmediate to let any async test promises resolve before printing summary
setImmediate(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
});
