// v6.13.2 — Static MLB team → division map (Rule 4 same-division check).
//
// Division ids are MLB Stats API division ids (200-205). The map is a verified
// snapshot of the current alignment; the adapter (fetchDivisionMap) refreshes it
// live from /teams each season and falls back to this static map on any failure,
// so Rule 4's same-division test is never blocked by an upstream outage.
//
//   200 AL West      201 AL East      202 AL Central
//   203 NL East      204 NL Central   205 NL West

export const DIVISION_IDS = [200, 201, 202, 203, 204, 205] as const;

// teamId → divisionId
export const TEAM_DIVISION: Record<number, number> = {
  // AL West (200)
  108: 200, 117: 200, 133: 200, 136: 200, 140: 200,
  // AL East (201)
  110: 201, 111: 201, 139: 201, 141: 201, 147: 201,
  // AL Central (202)
  114: 202, 116: 202, 118: 202, 142: 202, 145: 202,
  // NL East (203)
  109: 203, 115: 203, 119: 203, 135: 203, 137: 203,
  // NL Central (204)
  120: 204, 121: 204, 143: 204, 144: 204, 146: 204,
  // NL West (205)
  112: 205, 113: 205, 134: 205, 138: 205, 158: 205,
};

// Build a fresh Map from the static table (defensive copy for adapter fallback).
export function staticDivisionMap(): Map<number, number> {
  return new Map(Object.entries(TEAM_DIVISION).map(([k, v]) => [Number(k), v]));
}
