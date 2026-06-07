// Team offense ratings + Pythagenpat win expectancy — ported from
// sports-engine sports/mlb/ratings.py.

export const LG_AVG_RPG = 4.5;
export const LG_AVG_OPS = 0.73;

export interface TeamOffense {
  available: boolean;
  team?: string;
  rpg?: number | null;
  ops?: number | null;
  obp?: number | null;
  slg?: number | null;
}

export function pythagoreanWinPct(rs: number, ra: number, exp = 1.83): number {
  if (rs <= 0 || ra <= 0) return 0.5;
  return rs ** exp / (rs ** exp + ra ** exp);
}

// Pythagenpat (Smyth 2003): adaptive exponent = ((RS+RA)/G)^0.287.
export function pythagenpatWinPct(rs: number, ra: number): number {
  if (rs <= 0 || ra <= 0) return 0.5;
  const rpgSum = rs + ra;
  if (rpgSum <= 0) return 0.5;
  const exp = rpgSum ** 0.287;
  return rs ** exp / (rs ** exp + ra ** exp);
}
