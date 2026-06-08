import { Link } from "wouter";
import { TierPill } from "./TierPill";
import { fmtLine } from "@/lib/format";
import type { BuiltPick } from "@/lib/types";

// Compact card for non-actionable games. PASS = "no edge — fair price";
// HARD_PASS (hardPassReason present) = reason line, dimmed.
export function CompactCard({ pick }: { pick: BuiltPick }) {
  const hardPass = Boolean(pick.hardPassReason);
  return (
    <article
      className={`flex flex-col gap-1.5 rounded-xl border border-card-border bg-navy-card p-3 ${
        hardPass ? "opacity-55" : ""
      }`}
      data-testid={`compact-card-${pick.gameId}`}
    >
      <div className="flex items-center justify-between gap-2">
        <TierPill tier={pick.verdictTier} />
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {pick.sport}
        </span>
      </div>
      <Link href={`/pick/${pick.gameId}`} className="text-sm font-medium text-foreground hover:text-gold">
        {pick.awayTeam} @ {pick.homeTeam} · {pick.gameTimeEt}
      </Link>
      {hardPass ? (
        <div className="text-[11px] text-muted-foreground" data-testid="hard-pass-reason">
          Hard pass — {pick.hardPassReason?.replace(/_/g, " ")}
        </div>
      ) : (
        <div className="text-[11px] text-muted-foreground">
          No edge — fair price{pick.pickMl !== null ? ` (${pick.pickTeam} ${fmtLine(pick.pickMl)})` : ""}
        </div>
      )}
    </article>
  );
}
