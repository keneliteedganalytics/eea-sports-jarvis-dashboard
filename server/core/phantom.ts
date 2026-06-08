// Phantom-edge detector (SPEC §1, P0). A "phantom edge" is a fat model edge
// produced by a pricing artifact — the model fell back to a league-average prior
// because real inputs were missing, so any surfaced edge is noise, not signal.
// When detected, the pick is forced to PASS with zero units and a phantomEdge
// flag the UI renders as a yellow data-gap badge.

export const PHANTOM_NOTE_PATTERNS: RegExp[] = [
  /no offense data/i,
  /no FIP data/i,
  /no FIP\/ERA/i,
  /no RPG\/OPS/i,
  /team stats missing/i,
  /using league.*RPG/i,
  /using league.*GPG/i,
  /using league.*ORtg/i,
  /using league.*pace/i,
  /OPS blend skipped/i,
  // Soccer league-fallback patterns (v3)
  /using league.*GPG/i,
  /league-fallback.*goals/i,
  /missing team form/i,
];

export const PHANTOM_NOTE = "⚠️ Phantom edge detected — pricing artifact from missing data";

export function detectPhantomEdge(modelNotes: string[]): boolean {
  return modelNotes.some((n) => PHANTOM_NOTE_PATTERNS.some((p) => p.test(n)));
}
