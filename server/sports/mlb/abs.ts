// ABS (Automated Ball-Strike) framing exposure (MLB). With a robo-zone in play,
// a pitcher who has been quietly earning extra called strikes from catcher
// framing loses that edge. We estimate each starter's "framing dependency"
// (0–1) from their Baseball Savant pitcher card and convert it into a small FIP
// penalty: pitchers who lean on the human zone get worse under ABS.
//
// This is deliberately best-effort: the Savant card is optional, so any failure
// (network, parse, unknown id) yields framingDependency 0 — a no-op penalty that
// never blocks a pick.

import { getJson } from "../../adapters/http";

// effectiveFip += FRAMING_FIP_WEIGHT × framingDependency × ABS_INTENSITY_FACTOR
export const FRAMING_FIP_WEIGHT = 0.15;
export const ABS_INTENSITY_FACTOR = 1.0; // ramp toward full-ABS as the league phases it in

// Average innings per start (used to translate per-game framing runs → FIP units).
export const IP_PER_START_AVG = 5.5;

// Maximum FIP penalty from derivedFipPenalty (cap).
export const DERIVED_FIP_PENALTY_CAP = 0.40;

// Savant pitcher-card endpoint. We request the statcast pitching split as JSON;
// the page also serves a JSON document for the same player slug.
const SAVANT_URL = (slug: string) =>
  `https://baseballsavant.mlb.com/savant-player/${slug}?stats=statcast-r-pitching`;

export interface AbsAdjustment {
  framingDependency: number; // 0–1, clamped
  fipPenalty: number;        // runs added to effective FIP
  catcherFRS?: number | null; // framing-runs-saved per 162 G for the assigned catcher
  found: boolean;
}

export const NEUTRAL_ABS: AbsAdjustment = {
  framingDependency: 0,
  fipPenalty: 0,
  catcherFRS: null,
  found: false,
};

// ─── Fix 3: derivedFipPenalty ────────────────────────────────────────────────
//
// Derive the ABS FIP penalty as a function of:
//   absExposurePct — fraction of pitches subject to ABS challenges (0–1).
//   catcherFRS     — catcher framing runs saved per 162 games
//                    (+5 = great framer whose edge is now lost, −5 = bad framer
//                     who never provided edge to begin with).
//
// With ABS phasing in, framing-dependent pitchers who used to benefit from a
// skilled framer lose more than those paired with a poor framer.
//
// Formula:
//   lostFramingRunsPerGame = max(0, −catcherFRS / 162)
//     → converts negative catcher FRS (bad framer = no benefit to lose)
//       to zero; only good framers (positive FRS, negative catcherFRS) lose
//       something. Wait — good framer has POSITIVE catcherFRS, so the pitcher
//       LOSES that with ABS.
//     → lost framing runs = max(0, catcherFRS / 162)  [positive = runs were gained]
//   penalty = absExposurePct × (catcherFRS / 162) × 9 / IP_per_start_avg
//     → translates lost framing runs per game back to FIP units
//     → capped at DERIVED_FIP_PENALTY_CAP (+0.40 FIP)
//     → floored at 0 (bad framers don't improve the pitcher under ABS)
//
// Returns 0 when absExposurePct is 0 (ABS opt-out) regardless of catcherFRS.
export function derivedFipPenalty(
  absExposurePct: number,
  catcherFRS: number,
): number {
  if (absExposurePct <= 0) return 0;
  // Good framers (catcherFRS > 0) gave the pitcher extra called strikes.
  // Under ABS that edge evaporates. The pitcher loses max(0, catcherFRS) runs/162.
  const lostRunsPer162 = Math.max(0, catcherFRS);
  const lostRunsPerGame = lostRunsPer162 / 162;
  // Convert runs per game to FIP units (FIP ≈ runs × 9 / IP).
  const rawPenalty = absExposurePct * lostRunsPerGame * 9 / IP_PER_START_AVG;
  const penalty = Math.min(DERIVED_FIP_PENALTY_CAP, Math.max(0, rawPenalty));
  return round2(penalty);
}

// Build the Savant player slug: "firstname-lastname-mlbamId" (lowercased,
// non-alphanumerics collapsed to single dashes).
export function savantSlug(name: string | null | undefined, id: number | null | undefined): string | null {
  if (!name || id === null || id === undefined) return null;
  const namePart = name
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip accents
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!namePart) return null;
  return `${namePart}-${id}`;
}

// Convert a raw framing-runs-saved-style signal into a 0–1 dependency. The more
// a pitcher's results lean on borderline called strikes, the higher this is. We
// keep the mapping conservative and clamp hard so a noisy upstream value can't
// blow up the model.
export function framingDependencyFromSignal(calledStrikeAboveAvg: number | null): number {
  if (calledStrikeAboveAvg === null || Number.isNaN(calledStrikeAboveAvg)) return 0;
  // Map a positive "extra called strikes" rate into [0,1]. ~6pp extra ≈ fully
  // framing-dependent; negatives (pitchers who lose strikes) get 0.
  const dep = calledStrikeAboveAvg / 6.0;
  return Math.max(0, Math.min(1, dep));
}

// Pull a framing-dependency estimate for a starter. Best-effort: returns
// NEUTRAL_ABS on any failure so the model is never blocked.
//
// When catcherFRS is provided in options, derivedFipPenalty() is used for a
// more accurate FIP penalty; otherwise the flat absFipPenalty() formula is used.
export async function absAdjustmentForPitcher(
  name: string | null | undefined,
  id: number | null | undefined,
  options?: { catcherFRS?: number | null; absExposurePct?: number | null },
): Promise<AbsAdjustment> {
  const slug = savantSlug(name, id);
  if (!slug) return NEUTRAL_ABS;
  try {
    const res = await getJson<{
      // Savant exposes a number of split blocks; we look for a called-strike
      // edge metric if present. Shape is intentionally loose — unknown layouts
      // simply fall through to neutral.
      called_strike_above_avg?: number;
      stats?: { called_strike_above_avg?: number }[];
    }>(SAVANT_URL(slug));
    if (!res.ok || !res.data) return NEUTRAL_ABS;
    const raw =
      res.data.called_strike_above_avg ??
      res.data.stats?.[0]?.called_strike_above_avg ??
      null;
    const dep = framingDependencyFromSignal(raw ?? null);
    if (dep <= 0) return NEUTRAL_ABS;

    // Choose penalty computation:
    // • If catcherFRS is supplied, use derivedFipPenalty() for the framing-aware path.
    // • Otherwise fall back to the flat absFipPenalty() formula.
    const catcherFRS = options?.catcherFRS ?? null;
    const absExposurePct = options?.absExposurePct ?? 1.0;
    const fipPenalty =
      catcherFRS !== null && catcherFRS !== undefined
        ? derivedFipPenalty(absExposurePct, catcherFRS)
        : round2(FRAMING_FIP_WEIGHT * dep * ABS_INTENSITY_FACTOR);

    return {
      framingDependency: dep,
      fipPenalty,
      catcherFRS,
      found: true,
    };
  } catch {
    return NEUTRAL_ABS;
  }
}

// Compute the FIP penalty for a known framing dependency (pure; used by the
// model and tests without touching the network).
// NOTE: model.ts continues to call this directly. DO NOT change its signature.
export function absFipPenalty(framingDependency: number): number {
  const dep = Math.max(0, Math.min(1, framingDependency || 0));
  return round2(FRAMING_FIP_WEIGHT * dep * ABS_INTENSITY_FACTOR);
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
