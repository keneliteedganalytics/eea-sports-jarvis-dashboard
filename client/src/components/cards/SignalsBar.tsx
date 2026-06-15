// v6.9.1 — Brand Board v3 SignalsBar. Five rows (MARKET / SHARP / MODEL / PRISM /
// PREDICT), each a label (left, 11px uppercase silver) + bar (center, filled from
// the source's prob) + value (right, 13px tabular-num). A null source renders its
// label + a muted "—" with no bar. PRISM is a center-anchored velocity bar: a
// negative move tints left (red), a positive move tints right (green); 0/null is a
// flat centered "—". Consumes the PickSignals block the server now attaches to
// game-line, prop, and parlay-leg payloads.

import type { PickSignals, Signal } from "@/lib/types";

// Brand palette (matches the legacy SignalBars hex set).
const SILVER = "#8892A0";
const GOLD = "#C9A227";
const BLUE = "#5BC0EB";
const GREEN = "#3FB950";
const RED = "#E5534B";
// v6.10: deeper gold for the SABER pillar (distinguishes it from the standard MODEL gold)
const SABER_GOLD = "#9A7B1E";

function clampPct(prob: number | null): number {
  if (prob === null || !Number.isFinite(prob)) return 0;
  return Math.max(0, Math.min(100, prob * 100));
}

// A standard left-filled probability row (MARKET / SHARP / MODEL / PREDICT).
function ProbRow({ label, sig, color }: { label: string; sig: Signal | null; color: string }) {
  const prob = sig?.prob ?? null;
  const isNull = prob === null;
  const pct = clampPct(prob);
  return (
    <div className="flex items-center gap-2" data-testid={`signals-row-${label.toLowerCase()}`}>
      <span className="w-14 text-[11px] uppercase tracking-wider" style={{ color: SILVER }}>
        {label}
      </span>
      <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-white/5">
        {!isNull && (
          <div
            className="h-full rounded-full transition-all"
            data-testid={`signals-fill-${label.toLowerCase()}`}
            style={{ width: `${pct}%`, backgroundColor: color }}
          />
        )}
      </div>
      <span
        className="w-10 text-right text-[13px] tabular-nums"
        style={{ color: isNull ? SILVER : "#E6E9EF", opacity: isNull ? 0.5 : 1 }}
      >
        {isNull ? "—" : `${pct.toFixed(0)}%`}
      </span>
    </div>
  );
}

// PRISM = center-anchored velocity. edgePp is the open→current move in pp; we draw
// a bar growing left (red, market drifting away) or right (green, market moving to
// us) from the center. 0 / null collapses to a flat centered "—".
function PrismRow({ sig }: { sig: Signal | null }) {
  const move = sig?.edgePp ?? null;
  const isFlat = move === null || move === 0;
  // Scale: ±10pp fills half the track; clamp so big moves don't overflow.
  const mag = isFlat ? 0 : Math.min(50, (Math.abs(move!) / 10) * 50);
  const positive = (move ?? 0) > 0;
  return (
    <div className="flex items-center gap-2" data-testid="signals-row-prism">
      <span className="w-14 text-[11px] uppercase tracking-wider" style={{ color: SILVER }}>
        PRISM
      </span>
      <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-white/5">
        {/* center tick */}
        <div className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-white/15" />
        {!isFlat && (
          <div
            className="absolute top-0 h-full transition-all"
            data-testid={`signals-prism-${positive ? "pos" : "neg"}`}
            style={{
              width: `${mag}%`,
              [positive ? "left" : "right"]: "50%",
              backgroundColor: positive ? GREEN : RED,
              opacity: 0.85,
            }}
          />
        )}
      </div>
      <span
        className="w-10 text-right text-[13px] tabular-nums"
        style={{ color: isFlat ? SILVER : positive ? GREEN : RED, opacity: isFlat ? 0.5 : 1 }}
      >
        {isFlat ? "—" : `${positive ? "+" : ""}${move!.toFixed(1)}`}
      </span>
    </div>
  );
}

export function SignalsBar({ signals }: { signals: PickSignals | null | undefined }) {
  const s = signals ?? null;
  return (
    <div className="space-y-1.5" data-testid="signals-bar">
      <ProbRow label="MARKET" sig={s?.market ?? null} color={SILVER} />
      <ProbRow label="SHARP" sig={s?.sharp ?? null} color={SILVER} />
      <ProbRow label="MODEL" sig={s?.model ?? null} color={GOLD} />
      <PrismRow sig={s?.prism ?? null} />
      <ProbRow label="PREDICT" sig={s?.predict ?? null} color={SILVER} />
      {/* v6.10: SABER — sabermetric composite signal. Muted/em-dash when null. */}
      <ProbRow label="SABER" sig={s?.saber ?? null} color={SABER_GOLD} />
    </div>
  );
}
