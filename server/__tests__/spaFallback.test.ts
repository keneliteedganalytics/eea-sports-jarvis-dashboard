// SPA deep-link fallback (v6.7.10). The production server (server/static.ts)
// must serve the index.html shell — WITHOUT redirecting or rewriting the URL —
// for any non-API GET that doesn't match a static file, so a hard reload of a
// deep route like /parlays loads the bundle with location.pathname still set to
// /parlays (wouter then resolves the route). Mirrors serveStatic's middleware
// over a temp public dir. Run: tsx server/__tests__/spaFallback.test.ts

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";

// Temp public/ with a recognizable shell + a real asset file.
const pub = fs.mkdtempSync(path.join(os.tmpdir(), "spa-public-"));
const SHELL = '<!doctype html><html><head><script type="module" src="/assets/app.js"></script></head><body><div id="root"></div></body></html>';
fs.writeFileSync(path.join(pub, "index.html"), SHELL);
fs.mkdirSync(path.join(pub, "assets"));
fs.writeFileSync(path.join(pub, "assets", "app.js"), "/* bundle */");

// Mirror of serveStatic(app) from server/static.ts.
const app = express();
app.use(express.static(pub));
app.use("/{*path}", (_req, res) => {
  res.sendFile(path.resolve(pub, "index.html"));
});

const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>) {
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

console.log("SPA deep-link fallback — v6.7.10");

const DEEP_ROUTES = ["/parlays", "/analytics", "/archive", "/yesterday", "/track-record", "/pick/abc123"];

for (const route of DEEP_ROUTES) {
  await test(`GET ${route} returns 200 + the HTML shell, URL unchanged`, async () => {
    const res = await fetch(`${base}${route}`, { redirect: "manual" });
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    // No redirect — the browser keeps the requested URL so wouter sees it.
    assert.ok(res.status < 300 || res.status >= 400, "must not 3xx redirect");
    const body = await res.text();
    assert.ok(body.includes('<div id="root">'), "served the SPA shell");
    assert.ok(body.includes("/assets/app.js"), "shell references absolute /assets bundle");
  });
}

await test("real static asset is served directly (not the shell)", async () => {
  const res = await fetch(`${base}/assets/app.js`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(body.includes("/* bundle */"), "got the real asset, not index.html");
});

await test("root / serves the shell", async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes('<div id="root">'));
});

server.close();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
