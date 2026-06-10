// Unit: gradedBook.dbPath() resolution precedence. Verifies the SQLite file lands
// on a Railway persistent volume when one is mounted (so live scores + CLV state
// survive a deploy), with an explicit override taking top priority and the local
// data/ dir as the unchanged fallback. Run: tsx server/__tests__/gradedBookPath.test.ts

import assert from "node:assert/strict";
import path from "node:path";

const { dbPath } = await import("../gradedBook");

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`FAIL: ${name}\n  ${e instanceof Error ? e.message : e}`);
  }
}

// Save + restore the two env vars dbPath() reads so tests don't leak into each other.
const origGraded = process.env.GRADED_BOOK_PATH;
const origVol = process.env.RAILWAY_VOLUME_MOUNT_PATH;
function clearEnv(): void {
  delete process.env.GRADED_BOOK_PATH;
  delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
}

test("GRADED_BOOK_PATH wins over everything else", () => {
  clearEnv();
  process.env.GRADED_BOOK_PATH = "/tmp/foo.db";
  process.env.RAILWAY_VOLUME_MOUNT_PATH = "/data"; // present but lower precedence
  assert.equal(dbPath(), "/tmp/foo.db");
});

test("RAILWAY_VOLUME_MOUNT_PATH places the book on the volume", () => {
  clearEnv();
  process.env.RAILWAY_VOLUME_MOUNT_PATH = "/data";
  assert.equal(dbPath(), path.join("/data", "graded_book.db"));
});

test("blank RAILWAY_VOLUME_MOUNT_PATH falls through to the local default", () => {
  clearEnv();
  process.env.RAILWAY_VOLUME_MOUNT_PATH = "   ";
  assert.equal(dbPath(), path.join(process.cwd(), "data", "graded_book.db"));
});

test("neither set falls back to <cwd>/data/graded_book.db", () => {
  clearEnv();
  assert.equal(dbPath(), path.join(process.cwd(), "data", "graded_book.db"));
});

// Restore original env.
clearEnv();
if (origGraded !== undefined) process.env.GRADED_BOOK_PATH = origGraded;
if (origVol !== undefined) process.env.RAILWAY_VOLUME_MOUNT_PATH = origVol;

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
