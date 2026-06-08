import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { fmtLine, fmtPct } from "@/lib/format";
import type { BuiltPick } from "@/lib/types";

// Per-sport confidence drivers — the inputs the model weights when scoring this
// pick. Documents the deepened confidence model so the Why panel is explicit
// about what moved the number for each sport.
const CONFIDENCE_DRIVERS: Record<string, string> = {
  mlb: "Starter FIP/xFIP, lineup splits vs hand, bullpen rest & park factors",
  nhl: "Line combos, special teams (PP/PK), goalie SV% & rest, xGF%",
  nba: "ORtg/DRtg (L10), pace, rest & back-to-backs, injury point swings, home court",
  soccer: "Starting XI, recent form, head-to-head, travel & rest, xG/xGA",
};

// "Why this pick?" — expandable five-line analysis (FiveLineAnalysis pattern).
export function WhyPanel({ pick }: { pick: BuiltPick }) {
  const [open, setOpen] = useState(false);
  const drivers = CONFIDENCE_DRIVERS[pick.sport] ?? null;

  const lines: { label: string; value: string }[] = [
    {
      label: "Model vs market",
      value: `${pick.pickTeam} ${fmtPct(pick.pickWinProb)} model vs ${fmtPct(pick.pickImpliedProb)} implied — ${pick.edgePp ?? "—"}pp edge`,
    },
    {
      label: "Projected score",
      value: `${pick.awayTeam} ${pick.projAwayScore.toFixed(1)} — ${pick.homeTeam} ${pick.projHomeScore.toFixed(1)} (total ${pick.expectedTotal.toFixed(1)})`,
    },
    {
      label: "Fair line / CLV target",
      value: `${fmtLine(pick.fairMl)} fair vs ${fmtLine(pick.pickMl)} taken`,
    },
    {
      label: "Confidence",
      value: `${pick.confidence}/99${pick.isSparseModel ? " · sparse data" : ""}${pick.eliteFadeApplied ? " · elite-fade applied" : ""}`,
    },
    ...(drivers ? [{ label: "Confidence drivers", value: drivers }] : []),
    {
      label: "Signals",
      value: [
        pick.trapSignal ? `stale-line trap (${pick.trapGapPp}pp)` : null,
        pick.polymarket.found ? `PRISM ${pick.polymarket.pct?.toFixed(0)}%` : "no PRISM signal",
        `data ${pick.dataQualityTier}`,
      ]
        .filter(Boolean)
        .join(" · "),
    },
  ];

  return (
    <div className="border-t border-white/5 pt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-xs font-medium text-gold hover:text-gold-light"
        data-testid="button-why-toggle"
      >
        <span>Why this pick?</span>
        <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <dl className="mt-2 space-y-1.5" data-testid="why-panel-body">
          {lines.map((l) => (
            <div key={l.label} className="grid grid-cols-[7.5rem_1fr] gap-2 text-[12px]">
              <dt className="text-muted-foreground">{l.label}</dt>
              <dd className="text-foreground/90 tabular-nums">{l.value}</dd>
            </div>
          ))}
          {pick.modelNotes.length > 0 && (
            <ul className="space-y-0.5 pt-1" data-testid="why-model-notes">
              {pick.modelNotes.slice(0, 5).map((n, i) => (
                <li key={i} className="text-[11px] italic text-muted-foreground">· {n}</li>
              ))}
            </ul>
          )}
        </dl>
      )}
    </div>
  );
}
