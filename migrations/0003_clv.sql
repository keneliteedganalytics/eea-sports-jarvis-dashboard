-- Closing Line Value (CLV) tracking for the graded book
-- (server/gradedBook.ts → data/graded_book.db). When a game's lock window opens
-- (first pitch / tip / puck drop / kickoff) the lock worker snapshots the closing
-- line and computes CLV vs the price the pick was posted at.
--
-- gradedBook.ts applies these same columns at runtime (CREATE TABLE for fresh DBs,
-- ALTER TABLE ADD COLUMN via ensureColumns for existing ones), so this file is the
-- authoritative record for anyone applying it manually. SQLite has no
-- "ADD COLUMN IF NOT EXISTS"; run these only against a pre-CLV database.

ALTER TABLE picks ADD COLUMN gameStartIso TEXT;
ALTER TABLE picks ADD COLUMN postedOddsAmerican INTEGER;
ALTER TABLE picks ADD COLUMN postedAt TEXT;
ALTER TABLE picks ADD COLUMN closingOddsAmerican INTEGER;
ALTER TABLE picks ADD COLUMN closingCapturedAt TEXT;
ALTER TABLE picks ADD COLUMN closingSource TEXT;
ALTER TABLE picks ADD COLUMN clvPoints REAL;
ALTER TABLE picks ADD COLUMN clvPercent REAL;
ALTER TABLE picks ADD COLUMN lockStatus TEXT NOT NULL DEFAULT 'open';
