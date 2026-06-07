// Pitcher classification + data-quality gating — ported from sports-engine
// sports/mlb/pitchers.py. Thresholds per SPEC §4–§5 (May 2026 calibration).

export const FIP_CONSTANT = 3.1;
export const HARD_PASS_IP_THRESHOLD = 15.0; // sub-15 IP starter → HARD PASS
export const ELITE_FIP_THRESHOLD = 3.5; // sub-3.50 FIP + 80 IP = elite fade
export const ELITE_IP_MIN = 80.0; // SPEC §5 elite gate
export const SOLID_IP_MIN = 25.0;
export const SPARSE_IP_MIN = 15.0;

export type Classification = "ELITE" | "SOLID" | "SPARSE" | "HARD_PASS" | "NO_DATA";

export interface PitcherStats {
  available: boolean;
  reason?: string | null;
  pitcher: string;
  pitcherId?: number | null;
  hand?: string | null;
  ip?: number | null;
  gs?: number | null;
  era?: number | null;
  fip?: number | null;
  whip?: number | null;
  k9?: number | null;
  bb9?: number | null;
  hr9?: number | null;
  avgIp?: number | null;
  sparse?: boolean;
  sparseReason?: string | null;
  classification?: Classification | null;
  hardPassReason?: string | null;
}

export function computeFip(
  ip: number | null,
  hr: number | null,
  bb: number | null,
  k: number | null,
  ibb = 0,
  hbp = 0,
): number | null {
  if (!ip || ip <= 0) return null;
  if (hr === null || bb === null || k === null) return null;
  const bbEff = bb - (ibb || 0);
  const hbpEff = hbp || 0;
  const fip = (13 * hr + 3 * (bbEff + hbpEff) - 2 * k) / ip + FIP_CONSTANT;
  return Math.round(fip * 100) / 100;
}

// Classify a pitcher's data-quality tier (May 10, 2026 calibration).
export function classifyPitcher(stats: PitcherStats): {
  classification: Classification;
  hardPassReason: string | null;
  sparse?: boolean;
  sparseReason?: string | null;
} {
  if (!stats.available) {
    return {
      classification: "HARD_PASS",
      hardPassReason: stats.reason ?? "no data",
    };
  }

  const ip = stats.ip ?? 0;
  const fip = stats.fip ?? null;
  const era = stats.era ?? null;

  // HARD PASS: under 15 IP
  if (ip < HARD_PASS_IP_THRESHOLD) {
    return {
      classification: "HARD_PASS",
      hardPassReason: `Sub-${HARD_PASS_IP_THRESHOLD} IP starter (${ip.toFixed(1)} IP) — too thin for fair-line calc`,
      sparse: true,
      sparseReason: `IP=${ip.toFixed(1)} <${HARD_PASS_IP_THRESHOLD}`,
    };
  }

  // SPARSE: 15–25 IP
  if (ip < SOLID_IP_MIN) {
    return {
      classification: "SPARSE",
      hardPassReason: null,
      sparse: true,
      sparseReason: `IP=${ip.toFixed(1)} in ${HARD_PASS_IP_THRESHOLD}-${SOLID_IP_MIN} IP zone — downgrade confidence`,
    };
  }

  // HARD PASS: missing both FIP and ERA (broken row)
  if (fip === null && era === null) {
    return {
      classification: "HARD_PASS",
      hardPassReason: "Missing both FIP and ERA — broken data row",
    };
  }

  // ELITE: sub-3.50 FIP and >= 80 IP
  if (fip !== null && fip < ELITE_FIP_THRESHOLD && ip >= ELITE_IP_MIN) {
    return { classification: "ELITE", hardPassReason: null, sparse: false };
  }

  return { classification: "SOLID", hardPassReason: null, sparse: false };
}

export function isElitePitcher(stats: PitcherStats | null | undefined): boolean {
  return stats?.classification === "ELITE";
}

export type DataQualityTier = "HIGH" | "MEDIUM" | "PASS_HARD_GATE";

export function dataQualityTier(
  homeStats: PitcherStats,
  awayStats: PitcherStats,
): DataQualityTier {
  const h = homeStats.classification;
  const a = awayStats.classification;

  if (
    h === "HARD_PASS" ||
    a === "HARD_PASS" ||
    h === "NO_DATA" ||
    a === "NO_DATA"
  ) {
    return "PASS_HARD_GATE";
  }
  if (h === "SPARSE" || a === "SPARSE") return "MEDIUM";
  return "HIGH";
}
