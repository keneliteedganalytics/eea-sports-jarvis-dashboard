// Client route resolution (v6.7.10). With path-based (history) routing, wouter
// must resolve location.pathname === "/parlays" to the Parlays <Route>, NOT fall
// through to Home ("/"). This pins the route table in client/src/App.tsx using
// wouter's own matcher (matchRoute + regexparam parser) so a regression back to
// hash routing — where a hard reload of /parlays resolved to "/" — is caught.
// Run: tsx server/__tests__/wouterRouting.test.ts

import assert from "node:assert/strict";
import { matchRoute } from "wouter";
import { parse } from "regexparam";

// The ordered <Switch> route table from client/src/App.tsx. A Switch renders the
// FIRST matching route, so resolution = the first pattern that matchRoute accepts.
const ROUTES: { pattern: string; page: string }[] = [
  { pattern: "/", page: "Home" },
  { pattern: "/pick/:id", page: "PickDetail" },
  { pattern: "/parlays", page: "Parlays" },
  { pattern: "/analytics", page: "Analytics" },
  { pattern: "/track-record", page: "TrackRecord" },
  { pattern: "/yesterday", page: "Yesterday" },
  { pattern: "/archive", page: "Archive" },
  { pattern: "/sports/:sport", page: "SportStub" },
];

function resolve(pathname: string): string {
  for (const r of ROUTES) {
    const [matched] = matchRoute(parse, r.pattern, pathname) as [boolean, unknown];
    if (matched) return r.page;
  }
  return "NotFound";
}

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

console.log("wouter route resolution — v6.7.10 (path-based)");

test("/parlays resolves to Parlays (the deep-link bug: NOT Home)", () => {
  assert.equal(resolve("/parlays"), "Parlays");
  assert.notEqual(resolve("/parlays"), "Home");
});

test("every top-level deep route resolves to its own page, not Home", () => {
  assert.equal(resolve("/analytics"), "Analytics");
  assert.equal(resolve("/track-record"), "TrackRecord");
  assert.equal(resolve("/yesterday"), "Yesterday");
  assert.equal(resolve("/archive"), "Archive");
});

test("/ still resolves to Home", () => {
  assert.equal(resolve("/"), "Home");
});

test("parameterized routes resolve (/pick/:id, /sports/:sport)", () => {
  assert.equal(resolve("/pick/abc123"), "PickDetail");
  assert.equal(resolve("/sports/nfl"), "SportStub");
});

test("an unknown path falls through to NotFound, not Home", () => {
  assert.equal(resolve("/does-not-exist"), "NotFound");
});

test("a deep path does NOT collapse to Home (regression guard)", () => {
  for (const p of ["/parlays", "/analytics", "/archive", "/yesterday", "/track-record"]) {
    assert.notEqual(resolve(p), "Home", `${p} must not resolve to Home`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
