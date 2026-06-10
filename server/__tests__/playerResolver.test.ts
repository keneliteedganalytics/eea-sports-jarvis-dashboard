// Unit tests for the MLB Stats player-name → id resolver (v6.7.2). Covers name
// normalization (diacritics, generational suffixes, punctuation, whitespace), a
// mocked successful people/search lookup returning a numeric id, and the
// in-memory cache short-circuiting a second lookup for the same name.
// getJson hits the global fetch, so we stub globalThis.fetch.
// Run: tsx server/__tests__/playerResolver.test.ts

import assert from "node:assert/strict";
import {
  normalizePlayerName,
  resolveMlbPlayerId,
  _clearResolverCache,
} from "../sports/props/playerResolver";

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err as Error).message}`);
  }
}

const realFetch = globalThis.fetch;
function stubFetch(body: unknown, status = 200): () => number {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return {
      status,
      headers: { forEach: () => undefined },
      json: async () => body,
    } as unknown as Response;
  }) as typeof fetch;
  return () => calls;
}
function restoreFetch() {
  globalThis.fetch = realFetch;
}

console.log("player resolver");

await test("normalizePlayerName strips diacritics, suffixes, punctuation, whitespace", () => {
  assert.equal(normalizePlayerName("José Ramírez Jr."), "jose ramirez");
  assert.equal(normalizePlayerName("Ronald Acuña Jr."), "ronald acuna");
  assert.equal(normalizePlayerName("  Aaron   Judge  "), "aaron judge");
  assert.equal(normalizePlayerName("Cal Raleigh III"), "cal raleigh");
  assert.equal(normalizePlayerName("D'Angelo O'Neil"), "dangelo oneil");
});

await test("mocked successful search returns the numeric id", async () => {
  _clearResolverCache();
  stubFetch({ people: [{ id: 592450, fullName: "Aaron Judge" }] });
  const id = await resolveMlbPlayerId("Aaron Judge");
  restoreFetch();
  assert.equal(id, 592450);
});

await test("prefers an exact normalized-name match over the first result", async () => {
  _clearResolverCache();
  stubFetch({
    people: [
      { id: 1, fullName: "Aaron Judgey" },
      { id: 592450, fullName: "Aaron Judge" },
    ],
  });
  const id = await resolveMlbPlayerId("Aaron Judge");
  restoreFetch();
  assert.equal(id, 592450);
});

await test("cache hit does not re-call fetch for the same normalized name", async () => {
  _clearResolverCache();
  const calls = stubFetch({ people: [{ id: 605141, fullName: "Mookie Betts" }] });
  const a = await resolveMlbPlayerId("Mookie Betts");
  const b = await resolveMlbPlayerId("Mookie  Betts"); // same after normalization
  restoreFetch();
  assert.equal(a, 605141);
  assert.equal(b, 605141);
  assert.equal(calls(), 1, "fetch should be called exactly once across both lookups");
});

await test("empty result resolves to null and is cached as null", async () => {
  _clearResolverCache();
  const calls = stubFetch({ people: [] });
  const a = await resolveMlbPlayerId("Nobody McGee");
  const b = await resolveMlbPlayerId("Nobody McGee");
  restoreFetch();
  assert.equal(a, null);
  assert.equal(b, null);
  assert.equal(calls(), 1, "a null result is cached, not re-queried");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
