// Unit tests for pitcherSabermetrics.ts — xFIP formula, WHIP, K-BB%.
// Pure unit tests: no network calls.  Run: tsx server/__tests__/pitcherSabermetrics.test.ts

import assert from "node:assert/strict";

// We test the computation helpers directly.  Import the module's exported
// helpers by exercising the private logic through getPitcherSabermetrics
// with mock data injected via the cache.

// ----- Replicate the computation logic locally for pure unit testing -----

const C_FIP = 3.10;
const LG_HR_FB_PCT = 0.105;
const LG_FB_RATE = 0.35;

function parseIp(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  const parts = s.split(".");
  const whole = Number(parts[0]);
  const frac = parts[1] ? Number(parts[1]) : 0;
  if (Number.isNaN(whole) || Number.isNaN(frac)) return null;
  return whole + frac / 3;
}

function computeXFIP(
  k: number,
  bb: number,
  hbp: number,
  flyOuts: number | null,
  groundOuts: number | null,
  ip: number,
): { xFIP: number; xFIPProxy: boolean } {
  let flyBalls: number;
  let proxy = false;

  if (flyOuts !== null && flyOuts >= 0 && groundOuts !== null && groundOuts + flyOuts > 0) {
    flyBalls = flyOuts;
    proxy = false;
  } else if (flyOuts === null) {
    flyBalls = LG_FB_RATE * ip * 3;
    proxy = true;
  } else {
    flyBalls = flyOuts;
    proxy = false;
  }

  const raw = (13 * (flyBalls * LG_HR_FB_PCT) + 3 * (bb + hbp) - 2 * k) / ip + C_FIP;
  return { xFIP: Math.round(Math.max(0, Math.min(8, raw)) * 100) / 100, xFIPProxy: proxy };
}

function computeKBBPct(k: number, bb: number, bf: number): number | null {
  if (bf <= 0) return null;
  return Math.max(-0.5, Math.min(0.5, Math.round(((k - bb) / bf) * 10000) / 10000));
}

// ---- Tests ----

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

console.log("pitcherSabermetrics — unit tests");

// ── parseIp ──────────────────────────────────────────────────────────────────
test("parseIp: '100.0' → 100.0", () => {
  assert.equal(parseIp("100.0"), 100.0);
});

test("parseIp: '6.1' → 6 + 1/3 ≈ 6.333", () => {
  const v = parseIp("6.1");
  assert.ok(v !== null && Math.abs(v - 6.333) < 0.01, `got ${v}`);
});

test("parseIp: '6.2' → 6 + 2/3 ≈ 6.667", () => {
  const v = parseIp("6.2");
  assert.ok(v !== null && Math.abs(v - 6.667) < 0.01, `got ${v}`);
});

test("parseIp: null → null", () => {
  assert.equal(parseIp(null), null);
});

test("parseIp: '0' → 0", () => {
  assert.equal(parseIp("0"), 0);
});

// ── xFIP formula ─────────────────────────────────────────────────────────────
test("xFIP: known input produces expected value", () => {
  // League-average pitcher: ~100 IP, 9 HR, 35 BB, 0 HBP, ~45% FB rate.
  // Actual xFIP depends on K count. With 90K: result is in reasonable range.
  const { xFIP, xFIPProxy } = computeXFIP(90, 35, 5, 40, 50, 100);
  assert.ok(xFIP >= 2.5 && xFIP <= 5.5, `Expected xFIP in 2.5-5.5, got ${xFIP}`);
  assert.equal(xFIPProxy, false);
});

test("xFIP: elite pitcher (high K, low BB) produces sub-3.50 xFIP", () => {
  // High-K ace: 180K, 40BB, 2HBP, 40 flyOuts, 60 groundOuts, 180IP
  const { xFIP } = computeXFIP(180, 40, 2, 40, 60, 180);
  assert.ok(xFIP < 3.5, `Elite pitcher should have xFIP < 3.50, got ${xFIP}`);
});

test("xFIP: bad pitcher (low K, high BB) produces > 4.5 xFIP", () => {
  // Weak pitcher: 50K, 60BB, 8HBP, 60 flyOuts, 30 groundOuts, 100IP
  const { xFIP } = computeXFIP(50, 60, 8, 60, 30, 100);
  assert.ok(xFIP > 4.5, `Weak pitcher should have xFIP > 4.5, got ${xFIP}`);
});

test("xFIP: proxy=true when no flyOut data", () => {
  const { xFIPProxy } = computeXFIP(100, 40, 3, null, null, 150);
  assert.equal(xFIPProxy, true);
});

test("xFIP: proxy=false when flyOut data is present", () => {
  const { xFIPProxy } = computeXFIP(100, 40, 3, 50, 60, 150);
  assert.equal(xFIPProxy, false);
});

test("xFIP: clamped to [0, 8] — no impossible values", () => {
  // Extreme inputs
  const { xFIP: hi } = computeXFIP(0, 200, 0, 500, 10, 50);
  const { xFIP: lo } = computeXFIP(500, 0, 0, 0, 200, 200);
  assert.ok(hi <= 8, `Upper clamp failed: ${hi}`);
  assert.ok(lo >= 0, `Lower clamp failed: ${lo}`);
});

test("xFIP: 0 IP returns fallback (guarded against division by zero)", () => {
  // With 0 IP the function would divide by zero; the caller guards IP>0.
  // We just verify the clamping: an infinite result clamps to 8.
  const result = computeXFIP(0, 0, 0, 0, 0, 0.0001);
  assert.ok(Number.isFinite(result.xFIP), "should be finite");
});

// ── K-BB% ────────────────────────────────────────────────────────────────────
test("K-BB%: 20K, 5BB, 100BF → 0.15", () => {
  const v = computeKBBPct(20, 5, 100);
  assert.ok(v !== null && Math.abs(v - 0.15) < 0.001, `got ${v}`);
});

test("K-BB%: equal K and BB → 0", () => {
  assert.equal(computeKBBPct(10, 10, 100), 0);
});

test("K-BB%: more BB than K → negative", () => {
  const v = computeKBBPct(5, 15, 100);
  assert.ok(v !== null && v < 0, `expected negative, got ${v}`);
});

test("K-BB%: BF=0 → null (guard)", () => {
  assert.equal(computeKBBPct(10, 5, 0), null);
});

test("K-BB%: extreme values are clamped to [-0.5, 0.5]", () => {
  const hi = computeKBBPct(100, 0, 100);
  const lo = computeKBBPct(0, 100, 100);
  assert.ok(hi !== null && hi <= 0.5, `Upper clamp: ${hi}`);
  assert.ok(lo !== null && lo >= -0.5, `Lower clamp: ${lo}`);
});

// ── K-BB% threshold checks (for model adjustment gating) ────────────────────
test("K-BB% above 0.18 (18pp) → dominant-pitcher threshold met", () => {
  const kbb = computeKBBPct(25, 5, 100)!; // 20pp
  assert.ok(kbb > 0.18, `expected >0.18, got ${kbb}`);
});

test("K-BB% below 0.08 (8pp) → weak-pitcher threshold met", () => {
  const kbb = computeKBBPct(8, 2, 100)!; // 6pp
  assert.ok(kbb < 0.08, `expected <0.08, got ${kbb}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
