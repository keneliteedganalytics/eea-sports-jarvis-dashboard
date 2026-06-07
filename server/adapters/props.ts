// PrizePicks + Underdog props adapter — STUB for v2. Player-prop pricing is
// out of MVP scope; this returns no projections so the slate stays ML-only
// while keeping the integration point ready.

export interface PropProjection {
  book: "prizepicks" | "underdog";
  player: string;
  stat: string;
  line: number;
}

export function hasPropsSupport(): boolean {
  return false; // enabled in v2
}

export async function fetchProps(): Promise<PropProjection[]> {
  return [];
}
