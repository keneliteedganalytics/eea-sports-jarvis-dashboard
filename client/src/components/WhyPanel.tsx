import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { fmtLine, fmtPct } from "@/lib/format";
import type { BuiltPick } from "@/lib/types";

// "Why this pick?" — expandable five-line analysis (FiveLineAnalysis pattern).
export function WhyPanel({ pick }: { pick: BuiltPick }) {
  const [open, setOpen] = useState(false);

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
            <div className="pt-1 text-[11px] italic text-muted-foreground">{pick.modelNotes[0]}</div>
          )}
        </dl>
      )}
    </div>
  );
}
