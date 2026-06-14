// Shared multi-signal interface (v6.9.0). A pick can carry up to five
// independent directional reads of the same market. The tier engine uses these
// to require agreement before promoting to SNIPER (Foxtail-style confirmation),
// but the strict gate stays SHADOW-only until SHARP/PREDICT feeds are wired by
// the parallel surface — see signalAgreementForSniper() below, which degrades
// safely to a MODEL-only rule when the corroborating feeds are absent.
//
// `american` on each signal is the fair price that signal implies (null when the
// signal has no opinion). `edgePp` is that signal's edge in percentage points
// versus the posted market price (positive = value on our side).

export type SignalSource = "market" | "sharp" | "model" | "prism" | "predict";

export interface Signal {
  // Fair win/cover probability this source implies for our side, 0..1, or null.
  prob: number | null;
  // Edge in percentage points vs. the posted price (prob − impliedMarketProb)×100.
  edgePp: number | null;
  // Side this source backs, if any. Compared across sources for "agreement".
  side: "home" | "away" | "over" | "under" | null;
}

export interface PickSignals {
  market: Signal | null; // the posted line / consensus (our baseline)
  sharp: Signal | null; // sharp money / line-movement read (parallel agent)
  model: Signal | null; // our own projection model (always present)
  prism: Signal | null; // ensemble / calibration overlay
  predict: Signal | null; // prediction-market read e.g. Polymarket (parallel agent)
}

export const EMPTY_SIGNALS: PickSignals = {
  market: null,
  sharp: null,
  model: null,
  prism: null,
  predict: null,
};

// Strict-gate thresholds (v6.9.0). SNIPER requires the MODEL to lead by ≥5pp AND
// at least one corroborating feed (SHARP ≥3pp OR PREDICT ≥4pp) on the SAME side.
export const SNIPER_MODEL_EDGE_PP = 5;
export const SNIPER_SHARP_CONFIRM_PP = 3;
export const SNIPER_PREDICT_CONFIRM_PP = 4;
// Degraded gate when no corroborating feed exists yet: MODEL must lead by ≥6pp
// alone (matches the legacy TIER_SNIPER_EDGE so behavior is unchanged on ship).
export const SNIPER_MODEL_ONLY_EDGE_PP = 6;

export interface SignalAgreement {
  // True when the signals clear the SNIPER agreement bar.
  ok: boolean;
  // Which rule decided it: "confirmed" (corroborated) or "model_only" (degraded).
  mode: "confirmed" | "model_only" | "insufficient";
  // Human audit string for the debug surface.
  reason: string;
}

function sameSide(a: Signal | null, b: Signal | null): boolean {
  return !!a && !!b && a.side !== null && a.side === b.side;
}

// Decide whether a pick's signals support a SNIPER promotion. Pure + total: with
// only a model signal present it applies the degraded ≥6pp rule, so shipping
// before the SHARP/PREDICT feeds exist does not change current behavior.
export function signalAgreementForSniper(sig: PickSignals): SignalAgreement {
  const model = sig.model;
  const modelEdge = model?.edgePp ?? null;
  if (model === null || modelEdge === null || model.side === null) {
    return { ok: false, mode: "insufficient", reason: "no model signal" };
  }

  const sharpConfirms =
    sameSide(model, sig.sharp) && (sig.sharp?.edgePp ?? 0) >= SNIPER_SHARP_CONFIRM_PP;
  const predictConfirms =
    sameSide(model, sig.predict) && (sig.predict?.edgePp ?? 0) >= SNIPER_PREDICT_CONFIRM_PP;
  const hasCorroborator = sig.sharp !== null || sig.predict !== null;

  if (hasCorroborator) {
    if (modelEdge >= SNIPER_MODEL_EDGE_PP && (sharpConfirms || predictConfirms)) {
      const who = sharpConfirms ? "sharp" : "predict";
      return {
        ok: true,
        mode: "confirmed",
        reason: `model ${modelEdge.toFixed(1)}pp + ${who} confirm`,
      };
    }
    return {
      ok: false,
      mode: "confirmed",
      reason: `model ${modelEdge.toFixed(1)}pp without same-side confirm`,
    };
  }

  // Degraded: no corroborating feed wired yet → require the legacy ≥6pp lead.
  if (modelEdge >= SNIPER_MODEL_ONLY_EDGE_PP) {
    return { ok: true, mode: "model_only", reason: `model-only ${modelEdge.toFixed(1)}pp ≥ ${SNIPER_MODEL_ONLY_EDGE_PP}` };
  }
  return { ok: false, mode: "model_only", reason: `model-only ${modelEdge.toFixed(1)}pp < ${SNIPER_MODEL_ONLY_EDGE_PP}` };
}
