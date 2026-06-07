// Bullpen run adjustment — ported from sports-engine sports/mlb/bullpen.py.
// Returns RA/9 delta vs league-average bullpen FIP. Positive = worse bullpen.

export const LG_AVG_BULLPEN_FIP = 4.1;
export const LG_AVG_BULLPEN_ERA = 4.05;

export interface BullpenStats {
  available: boolean;
  team?: string;
  ip?: number | null;
  era?: number | null;
  fip?: number | null;
  sparse?: boolean;
}

export function bullpenRunAdjustment(
  bp: BullpenStats | null | undefined,
  lgAvgFip = LG_AVG_BULLPEN_FIP,
): number {
  if (!bp || !bp.available) return 0.0;
  const fip = bp.fip ?? null;
  if (fip === null) {
    const era = bp.era ?? null;
    if (era === null) return 0.0;
    return round2(era - LG_AVG_BULLPEN_ERA);
  }
  return round2(fip - lgAvgFip);
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
