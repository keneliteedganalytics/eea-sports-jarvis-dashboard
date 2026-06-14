import { Link } from "wouter";
import { TierPill } from "./TierPill";
import { ScopeFull } from "./ScopeFull";
import { SignalsBar } from "./cards/SignalsBar";
import { SpreadRow } from "./SpreadRow";
import { TotalRow } from "./TotalRow";
import { ClvBadge } from "./ClvBadge";
import { fmtGameDate, fmtGameTime, fmtLine, TIER_LABEL } from "@/lib/format";
import { gradeVisual } from "@/lib/grade";
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


  const grade = gradeVisual(pick);

  return (
    <article
      className={`flex flex-col overflow-hidden rounded-xl border bg-navy-deep ${grade ? "" : "border-card-border"} ${
        hardPass && !grade ? "opacity-55" : ""
      }`}
      style={
        grade
          ? {
              borderColor: grade.borderColor,
              borderWidth: grade.isFinal ? 3 : 2,
              boxShadow: grade.isFinal && grade.glow ? grade.glow : undefined,
              opacity: grade.isFinal ? grade.dim : undefined,
            }
          : undefined
      }
      data-testid={`compact-card-${pick.gameId}`}
    >
      {/* Brand header row: scope mark + tier wordmark + tier badge */}
      <div className="flex items-center justify-between gap-2 border-b border-gold/10 bg-gold/[0.03] px-3 py-2">
        <div className="flex items-center gap-1.5">
          <span className="overflow-hidden rounded-full">
            <ScopeFull uid={`ch-${pick.gameId}`} size={20} />
          </span>
          <span className="font-display text-[10px] font-extrabold uppercase tracking-[0.2em] text-gold-dark">
            {TIER_LABEL[pick.verdictTier]}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {grade?.live && (
            <span className="inline-flex items-center gap-1" data-testid={`live-indicator-${pick.gameId}`}>
              <span className="live-dot h-2 w-2 rounded-full bg-[#E8C14A]" />
              <span className="font-display text-[9px] font-bold uppercase tracking-[0.18em] text-[#E8C14A]">LIVE</span>
            </span>
          )}
          {grade?.isFinal ? (
            <span
              className="rounded-full px-2 py-0.5 font-display text-[10px] font-bold uppercase tracking-[0.14em]"
              style={{ color: "#020810", backgroundColor: grade.badgeColor }}
              data-testid={`result-pill-${pick.gameId}`}
            >
              {grade.badgeText}
            </span>
          ) : (
            <TierPill tier={pick.verdictTier} />
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2 p-3">
        {grade && !grade.isFinal && (
          <div
            className="rounded px-2 py-0.5 font-display text-[10px] font-bold uppercase tracking-wider"
            style={{ color: "#020810", backgroundColor: grade.badgeColor }}
            data-testid={`grade-badge-${pick.gameId}`}
          >
            {grade.badgeText}
          </div>
        )}
        {grade && !grade.isFinal && grade.scoreLine && (
          <div className="text-[11px] font-medium text-foreground/90" data-testid={`grade-score-${pick.gameId}`}>
            {grade.scoreLine}
          </div>
        )}
        {grade?.isFinal && grade.finalScoreLine && (
          <div
            className="font-display text-[15px] font-bold uppercase tracking-[0.06em] text-[#C0C6D0]"
            data-testid={`final-score-${pick.gameId}`}
          >
            {grade.finalScoreLine}
          </div>
        )}

        {/* Sport label */}
        <div className="flex items-center justify-end">
          <span className="font-display text-[10px] uppercase tracking-wider text-muted-foreground">
            {pick.sport}
          </span>
        </div>

        {/* Matchup link + date/time */}
        <div>
          <Link href={`/pick/${pick.gameId}`} className="text-sm font-medium text-foreground hover:text-gold-light">
            {pick.awayTeam} @ {pick.homeTeam}
          </Link>
          <div className="mt-0.5 text-[11px] tabular-nums text-muted-foreground" data-testid="card-datetime">
            {[fmtGameDate(pick.gameDate), fmtGameTime(pick.gameTimeEt)].filter(Boolean).join(" · ") || "Time TBD"}
          </div>
        </div>

        {/* MLB pitcher row */}
        {showPitcherRow && (
          <div className="text-xs text-slate" data-testid="pitcher-row">
            SP: {awaySpName ?? "TBD"}{awaySpEra ? ` (${awaySpEra} ERA)` : ""} vs {homeSpName ?? "TBD"}{homeSpEra ? ` (${homeSpEra} ERA)` : ""}
          </div>
        )}

        {/* Soccer league + form row */}
        {isSoccer && (
          <div className="text-xs text-slate" data-testid="soccer-league-row">
            {leaguePrefix}
            {(homeFormStr || awayFormStr) && (
              <span> Form: {awayFormStr ?? "—"} vs {homeFormStr ?? "—"}</span>
            )}
          </div>
        )}

        {/* NHL goalie row */}
        {showGoalieRow && (
          <div className="text-xs text-slate" data-testid="goalie-row">
            G: {awayGoalieName ?? "TBD"}{awayGoalieSvPct ? ` (${awayGoalieSvPct})` : ""} vs {homeGoalieName ?? "TBD"}{homeGoalieSvPct ? ` (${homeGoalieSvPct})` : ""}
          </div>
        )}

        {/* Projected score */}
        {showProjScore && (
          <div className="text-xs text-slate" data-testid="proj-score">
            Projected: {pick.awayTeam} {pick.projAwayScore.toFixed(1)} — {pick.homeTeam} {pick.projHomeScore.toFixed(1)}
          </div>
        )}

        {/* Spread + total markets — always rendered ("No market" when unposted) */}
        <div className="flex flex-col gap-1 rounded-lg border border-card-border bg-background/40 px-2.5 py-2" data-testid="markets-block">
          <SpreadRow market={pick.markets.spread} label={SPREAD_LABEL[pick.sport] ?? "SPR"} />
          <TotalRow market={pick.markets.total} />
        </div>

        {/* v6.9.1 five-source SignalsBar (Brand Board v3) */}
        <SignalsBar signals={pick.signals} />

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

        {/* Closing Line Value (only present once a posted price was captured) */}
        <ClvBadge pick={pick} />
      </div>

      {/* Brand footer: scope mark + wordmark */}
      <div className="flex items-center justify-between gap-2 border-t border-gold/10 px-3 py-1.5">
        <div className="flex items-center gap-1.5">
          <span className="overflow-hidden rounded-full">
            <ScopeFull uid={`cf-${pick.gameId}`} size={14} />
          </span>
          <span className="font-display text-[9px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
            Elite Edge Analytics
          </span>
        </div>
        <span className="text-[9px] tabular-nums text-muted-foreground">
          {fmtGameDate(pick.gameDate) || ""}
        </span>
      </div>
    </article>
  );
}
