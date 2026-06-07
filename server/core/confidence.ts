// Confidence scoring — ported from sports-engine core/confidence.py.
// 7-component additive score, base 30, clamped 0–99. VALUE cap 72.

import type { ConfidenceSignals } from "./types";

export function computeConfidence(s: ConfidenceSignals): number {
  let score = 30.0; // base floor

  // 1. Edge magnitude (0–25)
  score += Math.min(25.0, Math.abs(s.edgePp) * 5.0);

  // 2. Data completeness (0–20) — 5 pts per verified slot
  if (s.hasPickTeamOffense) score += 5.0;
  if (s.hasOppTeamOffense) score += 5.0;
  if (s.hasPickStarter) score += 5.0;
  if (s.hasOppStarter) score += 5.0;

  // 3. Sample reliability (0–10)
  score += Math.max(0.0, Math.min(10.0, s.sampleReliabilityRaw ?? 0));

  // 4. Positive EV (0–5)
  if (s.evPer100 > 0) score += 5.0;

  // 5. Signal alignment (0–5)
  const primary = s.primarySignalFavorsPick;
  const secondary = s.secondarySignalFavorsPick;
  if (primary === true && secondary === true) score += 5.0;
  else if (primary === true || secondary === true) score += 2.0;

  // 6. Polymarket agreement (0–4)
  if (s.polymarketPctForPick !== null && s.polymarketPctForPick !== undefined) {
    const pct = s.polymarketPctForPick;
    if (pct >= 55 && s.modelProb >= 0.5) score += 4.0;
    else if (pct >= 45 && s.modelProb >= 0.5) score += 1.5;
  }

  // 7. Sparse-model penalty (subtractive, up to –10)
  if (s.isSparse) {
    const sev = Math.max(0.0, Math.min(1.0, s.sparseSeverity ?? 0.5));
    score -= 10.0 * sev;
  }

  // 8. Directional penalty for VALUE plays (model thinks our side is dog)
  if (s.modelProb !== null && s.modelProb !== undefined && s.modelProb < 0.5) {
    const directionalPenalty = (0.5 - s.modelProb) * 50.0; // max 25 at p=0
    score -= directionalPenalty;
    score = Math.min(score, 72.0); // VALUE cap
  }

  return Math.max(0, Math.min(99, Math.round(score)));
}
