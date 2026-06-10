// Big-dog stake taper (v6.6 sharp calibration). Kelly over-sizes long-shot dogs
// because the model's tail probabilities are not calibrated against a real
// market. We multiply Kelly units by a decreasing factor as the price climbs,
// and hard-reject anything at +1001 or longer. Applied AFTER Kelly/conviction
// sizing, BEFORE the verdict tier assignment, in every sport's pick engine.

export const BIG_DOG_REJECT_ODDS = 1001; // +1001 and longer → 0 units (hard reject)

// Taper factor for a given American price. Favorites and short dogs are full
// size; the factor decays through the dog bands and hits 0 past +1000.
export function bigDogTaperFactor(americanOdds: number): number {
  // Favorites (negative) and even-money to +200 dogs: untouched.
  if (americanOdds <= 200) return 1.0;
  if (americanOdds <= 400) return 0.5;
  if (americanOdds <= 600) return 0.25;
  if (americanOdds <= 1000) return 0.1;
  return 0.0; // +1001 and up
}

// Apply the taper to a Kelly/conviction unit count for the given price. Rounds
// to the hundredth so downstream stake math stays clean.
export function taperBigDogStake(units: number, americanOdds: number): number {
  const tapered = units * bigDogTaperFactor(americanOdds);
  return Math.round(tapered * 100) / 100;
}

// Spec referenced this name once; keep it as an alias so either spelling works.
export const tapeBigDogStake = taperBigDogStake;

// ── EV-per-100 display ceiling (v6.6) ───────────────────────────────
// Any raw EV/$100 above +30 is a calibration artifact, not real value. We keep
// the raw number for audit but display a capped 30 and flag it so the card UI
// never renders an edge bar that exceeds 100%.
export const EV_DISPLAY_CAP = 30;

export interface CappedEv {
  evPer100: number; // capped display value
  evPer100Raw: number; // original raw value
  evCapped: boolean; // true when the cap bit
}

export function capEvPer100(raw: number): CappedEv {
  if (raw > EV_DISPLAY_CAP) {
    return { evPer100: EV_DISPLAY_CAP, evPer100Raw: raw, evCapped: true };
  }
  return { evPer100: raw, evPer100Raw: raw, evCapped: false };
}

// ── Daily-cap ranking score (v6.6) ──────────────────────────────────
// Keep the best N actionable plays per sport by confidence × edge, deflated by
// the priced probability so heavy chalk doesn't crowd out genuine value.
// score = confidence × edgePp / sqrt(1 + impliedProb)
export function pickRankScore(
  confidence: number,
  edgePp: number | null,
  impliedProb: number | null,
): number {
  const edge = edgePp ?? 0;
  const ip = impliedProb ?? 0;
  return (confidence * edge) / Math.sqrt(1 + ip);
}
