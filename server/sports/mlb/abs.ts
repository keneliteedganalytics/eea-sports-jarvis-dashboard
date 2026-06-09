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

// Savant pitcher-card endpoint. We request the statcast pitching split as JSON;
// the page also serves a JSON document for the same player slug.
const SAVANT_URL = (slug: string) =>
  `https://baseballsavant.mlb.com/savant-player/${slug}?stats=statcast-r-pitching`;

export interface AbsAdjustment {
  framingDependency: number; // 0–1, clamped
  fipPenalty: number; // runs added to effective FIP
  found: boolean;
}

export const NEUTRAL_ABS: AbsAdjustment = {
  framingDependency: 0,
  fipPenalty: 0,
  found: false,
};

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
export async function absAdjustmentForPitcher(
  name: string | null | undefined,
  id: number | null | undefined,
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
    return {
      framingDependency: dep,
      fipPenalty: round2(FRAMING_FIP_WEIGHT * dep * ABS_INTENSITY_FACTOR),
      found: true,
    };
  } catch {
    return NEUTRAL_ABS;
  }
}

// Compute the FIP penalty for a known framing dependency (pure; used by the
// model and tests without touching the network).
export function absFipPenalty(framingDependency: number): number {
  const dep = Math.max(0, Math.min(1, framingDependency || 0));
  return round2(FRAMING_FIP_WEIGHT * dep * ABS_INTENSITY_FACTOR);
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
