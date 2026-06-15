// v6.10 — SaberEdgePanel: collapsible sabermetric edge section for PickCard.
// Shows pitcher xFIP/K-BB%/WHIP, offense wRC+/wOBA, park, umpire, weather, verdict.
// Collapsed by default; tap header to expand. Saves preference to localStorage.

import { useState, useEffect } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { BuiltPick } from "@/lib/types";

const LS_KEY = "eea_saber_expanded";

function saberExpandedDefault(): boolean {
  try {
    return localStorage.getItem(LS_KEY) === "true";
  } catch {
    return false;
  }
}

function setSaberExpanded(v: boolean): void {
  try {
    localStorage.setItem(LS_KEY, v ? "true" : "false");
  } catch {
    // ignore
  }
}

function pct(v: number | null | undefined, decimals = 1): string {
  if (v == null) return "—";
  return `${(v * 100).toFixed(decimals)}%`;
}

function dec(v: number | null | undefined, decimals = 2): string {
  if (v == null) return "—";
  return v.toFixed(decimals);
}

function signed(v: number | null | undefined, decimals = 3): string {
  if (v == null) return "—";
  return v >= 0 ? `+${v.toFixed(decimals)}` : v.toFixed(decimals);
}

interface Props {
  pick: BuiltPick;
}

export function SaberEdgePanel({ pick }: Props) {
  const [expanded, setExpanded] = useState(saberExpandedDefault);

  // Persist preference on change.
  useEffect(() => {
    setSaberExpanded(expanded);
  }, [expanded]);

  // Only render for MLB picks.
  if (pick.sport !== "mlb") return null;

  const pe = pick.pitcherEdge;
  const oe = pick.offenseEdge;

  // If neither pitcher nor offense edge data is present, don't render the panel.
  const hasPitcherData = pe && (pe.homeXfip != null || pe.awayXfip != null);
  const hasOffenseData = oe && (oe.homeWrcPlus != null || oe.awayWrcPlus != null);
  if (!hasPitcherData && !hasOffenseData) return null;

  const homeName = pick.homeTeam;
  const awayName = pick.awayTeam;
  const homePitcher = pe?.homePitcherName ?? pick.homeSp?.pitcher ?? homeName;
  const awayPitcher = pe?.awayPitcherName ?? pick.awaySp?.pitcher ?? awayName;

  // Verdict line
  const projHome = pick.projHomeScore?.toFixed(1) ?? "—";
  const projAway = pick.projAwayScore?.toFixed(1) ?? "—";
  const verdictSide = pick.pickSide === "home" ? homeName : awayName;
  const verdictPrice = pick.pickMl != null ? (pick.pickMl > 0 ? `+${pick.pickMl}` : `${pick.pickMl}`) : "—";
  const verdictEdge = pick.edgePp != null ? `${pick.edgePp > 0 ? "+" : ""}${pick.edgePp.toFixed(0)}pp` : "";
  const verdictTier = pick.verdictTier !== "PASS" ? pick.verdictTier : null;

  return (
    <div className="mt-1 rounded-lg border border-gold/10 bg-navy-deep/60" data-testid="saber-edge-panel">
      {/* Header — always visible */}
      <button
        className="flex w-full items-center justify-between px-3 py-2 text-left"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        data-testid="saber-edge-toggle"
      >
        <span
          className="font-display text-[11px] font-bold uppercase tracking-[0.18em]"
          style={{ color: "#9A7B1E" }}
        >
          Sabermetric Edge
        </span>
        {expanded ? (
          <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        )}
      </button>

      {/* Body — collapsible */}
      {expanded && (
        <div
          className="space-y-2 px-3 pb-3 text-[11px] leading-relaxed text-muted-foreground"
          data-testid="saber-edge-body"
        >
          {/* SP section */}
          {hasPitcherData && (
            <div className="space-y-0.5">
              <div className="font-bold uppercase tracking-wider text-[10px]" style={{ color: "#9A7B1E" }}>SP</div>
              <div className="font-mono">
                {homeName}{" "}
                <span className="text-foreground">{homePitcher}</span>
                {pe?.homeXfip != null && ` xFIP ${dec(pe.homeXfip)}`}
                {pe?.homeKMinusBBPct != null && ` · K-BB% ${pct(pe.homeKMinusBBPct, 1)}`}
                {pe?.homeWhip != null && ` · WHIP ${dec(pe.homeWhip)}`}
              </div>
              <div className="font-mono">
                {awayName}{" "}
                <span className="text-foreground">{awayPitcher}</span>
                {pe?.awayXfip != null && ` xFIP ${dec(pe.awayXfip)}`}
                {pe?.awayKMinusBBPct != null && ` · K-BB% ${pct(pe.awayKMinusBBPct, 1)}`}
                {pe?.awayWhip != null && ` · WHIP ${dec(pe.awayWhip)}`}
              </div>
              {pe?.edgeSummary && (
                <div className="text-[10px]">
                  <span className="text-foreground/70">→</span> {pe.edgeSummary}
                </div>
              )}
            </div>
          )}

          {/* Offense section */}
          {hasOffenseData && (
            <div className="space-y-0.5">
              <div className="font-bold uppercase tracking-wider text-[10px]" style={{ color: "#9A7B1E" }}>OFFENSE</div>
              <div className="font-mono">
                {homeName} wRC+ {oe?.homeWrcPlus ?? "—"} · {awayName} wRC+ {oe?.awayWrcPlus ?? "—"}
              </div>
              {(oe?.homeWobaVsRhp != null || oe?.awayWobaVsRhp != null) && (
                <div className="font-mono">
                  vs RHP: {homeName} {signed(oe?.homeWobaVsRhp)} wOBA · {awayName} {signed(oe?.awayWobaVsRhp)} wOBA
                </div>
              )}
              {oe?.edgeSummary && (
                <div className="text-[10px]">
                  <span className="text-foreground/70">→</span> {oe.edgeSummary}
                </div>
              )}
            </div>
          )}

          {/* Park / Ump / Weather */}
          <div className="space-y-0.5">
            <div className="font-bold uppercase tracking-wider text-[10px]" style={{ color: "#9A7B1E" }}>CONTEXT</div>
            <div className="font-mono">
              PARK: {pick.venue ?? "—"}
              {pick.projHomeScore != null && ` · PF ~${(pick.projHomeScore / 4.5).toFixed(2)}`}
            </div>
            {pick.umpireName && (
              <div className="font-mono">
                UMP: {pick.umpireName}
                {pick.umpireRunAdj != null && ` (${pick.umpireRunAdj >= 0 ? "+" : ""}${pick.umpireRunAdj.toFixed(2)} r/gm)`}
              </div>
            )}
          </div>

          {/* Verdict */}
          <div
            className="mt-1 rounded border border-gold/20 bg-gold/[0.06] px-2.5 py-1.5 font-mono text-[11px]"
            data-testid="saber-verdict"
          >
            <span className="font-bold text-foreground">VERDICT:</span>{" "}
            MODEL projects {homeName} {projHome} · {awayName} {projAway} —{" "}
            {verdictSide} {verdictTier ? `${verdictPrice} ${verdictTier}` : verdictPrice}
            {verdictEdge && ` ${verdictEdge}`}
          </div>
        </div>
      )}
    </div>
  );
}
