import { Link } from "wouter";
import { TierPill } from "./TierPill";
import { SignalBars } from "./SignalBars";
import { SpreadRow } from "./SpreadRow";
import { TotalRow } from "./TotalRow";
import { fmtGameDate, fmtGameTime, fmtLine } from "@/lib/format";
import type { BuiltPick } from "@/lib/types";

const SPREAD_LABEL: Record<string, string> = { mlb: "RL", nhl: "PL", nba: "SPR", soccer: "AH" };

// Compact card for non-actionable (PASS / HARD_PASS) games.
// Shows informational data the engine pulled — matchup, sport-specific detail
// rows (pitcher / goalie / form), projected score, markets, public/sharp bars,
// and the reason text — but NO betting affordances (units, stake, EV, props).
export function CompactCard({ pick }: { pick: BuiltPick }) {
  const hardPass = Boolean(pick.hardPassReason);

  // MLB pitcher row
  const isMLB = pick.sport === "mlb";
  const isSoccer = pick.sport === "soccer";
  const isNHL = pick.sport === "nhl";
  const awaySpName = pick.awaySp?.available === false ? "TBD" : (pick.awaySp?.pitcher ?? null);
  const homeSpName = pick.homeSp?.available === false ? "TBD" : (pick.homeSp?.pitcher ?? null);
  const awaySpEra = pick.awaySp?.era != null ? pick.awaySp.era.toFixed(2) : null;
  const homeSpEra = pick.homeSp?.era != null ? pick.homeSp.era.toFixed(2) : null;
  const showPitcherRow = isMLB && (awaySpName !== null || homeSpName !== null);

  // NHL goalie row
  const awayGoalieName = pick.awayGoalie?.available
    ? (pick.awayGoalie.name ?? "TBD")
    : pick.awayGoalie ? "TBD" : null;
  const homeGoalieName = pick.homeGoalie?.available
    ? (pick.homeGoalie.name ?? "TBD")
    : pick.homeGoalie ? "TBD" : null;
  const awayGoalieSvPct =
    pick.awayGoalie?.available && pick.awayGoalie.svPct != null
      ? `.${Math.round(pick.awayGoalie.svPct * 1000).toString().padStart(3, "0")} SV%`
      : null;
  const homeGoalieSvPct =
    pick.homeGoalie?.available && pick.homeGoalie.svPct != null
      ? `.${Math.round(pick.homeGoalie.svPct * 1000).toString().padStart(3, "0")} SV%`
      : null;
  const showGoalieRow = isNHL && (awayGoalieName !== null || homeGoalieName !== null);

  // Soccer form row
  const leaguePrefix = isSoccer ? (pick.leaguePrefix ?? (pick.leagueName ? `${pick.leagueName} ·` : "Soccer ·")) : null;
  const homeFormStr = pick.homeForm ?? null;
  const awayFormStr = pick.awayForm ?? null;

  // Projected score
  const showProjScore = pick.projAwayScore != null && pick.projHomeScore != null;

  // Signal bars — always rendered (PRISM/public/sharp show "—" when unavailable).
  const publicPct = pick.publicPct;
  const sharpPct = pick.sharpPct;
  const prismPct = pick.polymarket.found ? pick.polymarket.pct ?? null : null;
  const prismReason = !pick.polymarket.found ? (pick.polymarket.reason ?? "No Polymarket market available") : null;

  return (
    <article
      className={`flex flex-col gap-2 rounded-xl border border-card-border bg-navy-card p-3 ${
        hardPass ? "opacity-55" : ""
      }`}
      data-testid={`compact-card-${pick.gameId}`}
    >
      {/* Header: tier pill + sport label */}
      <div className="flex items-center justify-between gap-2">
        <TierPill tier={pick.verdictTier} />
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {pick.sport}
        </span>
      </div>

      {/* Matchup link + date/time */}
      <div>
        <Link href={`/pick/${pick.gameId}`} className="text-sm font-medium text-foreground hover:text-gold">
          {pick.awayTeam} @ {pick.homeTeam}
        </Link>
        <div className="mt-0.5 text-[11px] tabular-nums text-muted-foreground" data-testid="card-datetime">
          {[fmtGameDate(pick.gameDate), fmtGameTime(pick.gameTimeEt)].filter(Boolean).join(" · ") || "Time TBD"}
        </div>
      </div>

      {/* MLB pitcher row */}
      {showPitcherRow && (
        <div className="text-xs text-zinc-400" data-testid="pitcher-row">
          SP: {awaySpName ?? "TBD"}{awaySpEra ? ` (${awaySpEra} ERA)` : ""} vs {homeSpName ?? "TBD"}{homeSpEra ? ` (${homeSpEra} ERA)` : ""}
        </div>
      )}

      {/* Soccer league + form row */}
      {isSoccer && (
        <div className="text-xs text-zinc-400" data-testid="soccer-league-row">
          {leaguePrefix}
          {(homeFormStr || awayFormStr) && (
            <span> Form: {awayFormStr ?? "—"} vs {homeFormStr ?? "—"}</span>
          )}
        </div>
      )}

      {/* NHL goalie row */}
      {showGoalieRow && (
        <div className="text-xs text-zinc-400" data-testid="goalie-row">
          G: {awayGoalieName ?? "TBD"}{awayGoalieSvPct ? ` (${awayGoalieSvPct})` : ""} vs {homeGoalieName ?? "TBD"}{homeGoalieSvPct ? ` (${homeGoalieSvPct})` : ""}
        </div>
      )}

      {/* Projected score */}
      {showProjScore && (
        <div className="text-xs text-zinc-400" data-testid="proj-score">
          Projected: {pick.awayTeam} {pick.projAwayScore.toFixed(1)} — {pick.homeTeam} {pick.projHomeScore.toFixed(1)}
        </div>
      )}

      {/* Spread + total markets — always rendered ("No market" when unposted) */}
      <div className="flex flex-col gap-1 rounded-lg border border-card-border bg-background/40 px-2.5 py-2" data-testid="markets-block">
        <SpreadRow market={pick.markets.spread} label={SPREAD_LABEL[pick.sport] ?? "SPR"} />
        <TotalRow market={pick.markets.total} />
      </div>

      {/* Public / Sharp / PRISM bars — always rendered */}
      <SignalBars publicPct={publicPct} sharpPct={sharpPct} prismPct={prismPct} prismReason={prismReason} />

      {/* Reason text */}
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
