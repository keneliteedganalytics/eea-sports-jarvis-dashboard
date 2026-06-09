-- Bet lock-in for the graded book (server/gradedBook.ts → data/graded_book.db).
-- Once the user confirms a bet via POST /api/picks/:id/confirm-bet, the pick's
-- tier/stake/odds are frozen so a downstream slate recompute can never re-tier it.
--
-- gradedBook.ts applies these same columns at runtime (CREATE TABLE for fresh DBs,
-- ALTER TABLE ADD COLUMN for existing ones), so this file is the authoritative
-- record of the schema change for anyone applying it manually. SQLite has no
-- "ADD COLUMN IF NOT EXISTS"; run these only against a pre-lock database.

ALTER TABLE picks ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE picks ADD COLUMN lockedAt TEXT;
ALTER TABLE picks ADD COLUMN lockedTier TEXT;
ALTER TABLE picks ADD COLUMN lockedStake REAL;
ALTER TABLE picks ADD COLUMN lockedOdds INTEGER;
