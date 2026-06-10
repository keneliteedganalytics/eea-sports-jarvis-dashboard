-- Audit log for admin overrides on the graded book (server/gradedBook.ts →
-- data/graded_book.db). POST /api/picks/:id/admin-lock can override a pick's
-- tier/odds/stake before snapshot+lock to repair a row that a recompute
-- clobbered; every such change appends a row here.
--
-- gradedBook.ts creates this table at runtime (CREATE TABLE IF NOT EXISTS on
-- boot), so this file is the authoritative record of the schema change for
-- anyone applying it manually.

CREATE TABLE IF NOT EXISTS pick_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pickId TEXT,
  action TEXT,
  fromTier TEXT,
  toTier TEXT,
  fromOdds REAL,
  toOdds REAL,
  reason TEXT,
  createdAt TEXT
);
CREATE INDEX IF NOT EXISTS idx_pick_audit_pickId ON pick_audit(pickId);
