import { Link } from "wouter";
import { ArrowDown, ArrowUp } from "lucide-react";
import { TierPill } from "./TierPill";
import { ScopeFull } from "./ScopeFull";
import { SignalsBar } from "./cards/SignalsBar";
import { HitRateFooter } from "./HitRateFooter";
import { JarvisPlayer } from "./JarvisPlayer";
import { WhyPanel } from "./WhyPanel";
import { SpreadRow } from "./SpreadRow";
import { TotalRow } from "./TotalRow";
import { PropsPanel } from "./PropsPanel";
import { BetPlacedButton } from "./BetPlacedButton";
import { DraftKingsButton } from "./DraftKingsButton";
import { ClvBadge } from "./ClvBadge";
import { fmtGameDate, fmtGameTime, fmtLine, fmtMoney, fmtPct, fmtUnits, lineMovement, TIER_LABEL } from "@/lib/format";
import { gradeVisual } from "@/lib/grade";
import type { BuiltPick } from "@/lib/types";

const STEAM_CENTS = 10;

const SPREAD_LABEL: Record<string, string> = { mlb: "RL", nhl: "PL", nba: "SPR", soccer: "AH" };

export function PickCard({ pick, bankroll }: { pick: BuiltPick; bankroll: number }) {
  const openMl = pick.pickSide === "home" ? pick.openHomeMl : pick.openAwayMl;
  const move = lineMovement(openMl, pick.pickMl);
  const isSteam = move.cents >= STEAM_CENTS;

  // MLB pitcher row data
  const isMLB = pick.sport === "mlb";
  const isSoccer = pick.sport === "soccer";
  const awaySpName = pick.awaySp?.available === false ? "TBD" : (pick.awaySp?.pitcher ?? null);
  const homeSpName = pick.homeSp?.available === false ? "TBD" : (pick.homeSp?.pitcher ?? null);
  const awaySpEra = pick.awaySp?.era != null ? pick.awaySp.era.toFixed(2) : null;
  const homeSpEra = pick.homeSp?.era != null ? pick.homeSp.era.toFixed(2) : null;
  const showPitcherRow = isMLB && (awaySpName !== null || homeSpName !== null);

  // Soccer subtitle row
  const leaguePrefix = isSoccer ? (pick.leaguePrefix ?? (pick.leagueName ? `${pick.leagueName} ·` : "Soccer ·")) : null;
  const homeFormStr = pick.homeForm ?? null;
  const awayFormStr = pick.awayForm ?? null;
  const showSoccerRow = isSoccer;

  // NHL goalie row data — shown when at least one goalie is available
  const isNHL = pick.sport === "nhl";
  const awayGoalieName = pick.awayGoalie?.available
    ? (pick.awayGoalie.name ?? "TBD")
    : pick.awayGoalie
      ? "TBD"
      : null;
  const homeGoalieName = pick.homeGoalie?.available
    ? (pick.homeGoalie.name ?? "TBD")
    : pick.homeGoalie
      ? "TBD"
      : null;
  const awayGoalieSvPct =
    pick.awayGoalie?.available && pick.awayGoalie.svPct != null
      ? `.${Math.round(pick.awayGoalie.svPct * 1000).toString().padStart(3, "0")} SV%`
      : null;
  const homeGoalieSvPct =
    pick.homeGoalie?.available && pick.homeGoalie.svPct != null
      ? `.${Math.round(pick.homeGoalie.svPct * 1000).toString().padStart(3, "0")} SV%`
      : null;
  // Hide the goalie row only if both are completely absent (no data at all)
  const showGoalieRow = isNHL && (awayGoalieName !== null || homeGoalieName !== null);

  // Projected score line — shown on every sport when both scores available
  const showProjScore = pick.projAwayScore != null && pick.projHomeScore != null;

  const grade = gradeVisual(pick);

  return (
    <article
      className={`flex flex-col overflow-hidden rounded-xl border bg-navy-deep hover-elevate ${grade ? "" : "border-card-border"}`}
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
      data-testid={`pick-card-${pick.gameId}`}
    >
      {/* Brand header row: scope mark + tier wordmark + tier badge */}
      <div className="flex items-center justify-between gap-2 border-b border-gold/10 bg-gold/[0.04] px-3.5 py-2.5">
        <div className="flex items-center gap-2">
          <span className="overflow-hidden rounded-full">
            <ScopeFull uid={`ph-${pick.gameId}`} size={24} />
          </span>
          <span className="font-display text-[11px] font-extrabold uppercase tracking-[0.22em] text-gold">
            {TIER_LABEL[pick.verdictTier]}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {grade?.live && (
            <span className="inline-flex items-center gap-1" data-testid={`live-indicator-${pick.gameId}`}>
              <span className="live-dot h-2 w-2 rounded-full bg-[#E8C14A]" />
              <span className="font-display text-[10px] font-bold uppercase tracking-[0.18em] text-[#E8C14A]">LIVE</span>
            </span>
          )}
          {/* Final picks swap the tier pill for a colored result pill. */}
          {grade?.isFinal ? (
            <span
              className="rounded-full px-2.5 py-0.5 font-display text-[11px] font-bold uppercase tracking-[0.14em]"
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

      <div className="flex flex-col gap-3 p-4">
        {/* In-progress status badge (live). Final picks carry the result in the
            header pill, so the body badge is shown for live picks only. */}
        {grade && !grade.isFinal && (
          <div
            className="rounded px-2 py-1 font-display text-[11px] font-bold uppercase tracking-wider"
            style={{ color: "#020810", backgroundColor: grade.badgeColor }}
            data-testid={`grade-badge-${pick.gameId}`}
          >
            {grade.badgeText}
          </div>
        )}
        {grade && !grade.isFinal && grade.scoreLine && (
          <div className="text-xs font-medium text-foreground/90" data-testid={`grade-score-${pick.gameId}`}>
            {grade.scoreLine}
          </div>
        )}

        {/* Secondary badges */}
        {(pick.topPlay || pick.subSampleWarning || pick.phantomEdge || pick.trapSignal) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {pick.topPlay && (
              <span className="rounded px-1.5 py-0.5 font-display text-[10px] font-bold uppercase tracking-wider" style={{ color: "#020810", backgroundColor: "#C9A227" }} data-testid="top-play-badge">
                Top Play
              </span>
            )}
            {pick.subSampleWarning && (
              <span
                className="rounded px-1.5 py-0.5 font-display text-[10px] font-bold uppercase tracking-wider"
                style={{ color: "#020810", backgroundColor: "#C9A227" }}
                data-testid="sub25-badge"
                title={pick.subSampleDetails ?? "Sub-25 IP starter — judgment call"}
              >
                Sub-25 IP
              </span>
            )}
            {pick.phantomEdge && (
              <span className="rounded px-1.5 py-0.5 font-display text-[10px] font-bold uppercase tracking-wider" style={{ color: "#020810", backgroundColor: "#C9A227" }} data-testid="data-gap-badge">
                Data Gap
              </span>
            )}
            {pick.trapSignal && (
              <span className="rounded px-1.5 py-0.5 font-display text-[10px] font-bold uppercase tracking-wider" style={{ color: "#FF8A47", backgroundColor: "#FF8A4715" }}>
                Trap
              </span>
            )}
          </div>
        )}

        {/* v6.6 hard-gate PASS reason — compact, audit-visible. */}
        {pick.verdictTier === "PASS" && pick.passReason && (
          <div
            className="rounded border border-[#6B7A99]/30 bg-[#6B7A99]/10 px-2 py-1 text-[11px] font-medium text-[#9FB0C9]"
            data-testid={`pass-reason-${pick.gameId}`}
          >
            PASS: {pick.passReason}
          </div>
        )}

        {/* Units chip (large, gold) */}
        <div className="flex items-baseline gap-2">
          <span className="font-display text-3xl font-extrabold tabular-nums text-gold" data-testid={`units-${pick.gameId}`}>
            {pick.phantomEdge ? "—" : fmtUnits(pick.units)}
          </span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {pick.phantomEdge
              ? "data gap · no play"
              : pick.kellyStakeDollars > 0
                ? `${fmtMoney(pick.kellyStakeDollars)} stake`
                : "no stake"}
            {!pick.phantomEdge && pick.halfCut && " · half (juice)"}
            {!pick.phantomEdge && pick.trimmed && " · trimmed (cap)"}
          </span>
        </div>

        {/* Bet lock-in — actionable, non-final picks only. Greys out / locks once
            confirmed so the tier/stake/odds can't be silently re-tiered. */}
        {!pick.phantomEdge && pick.units > 0 && pick.verdictTier !== "PASS" && pick.gradeStatus !== "final" && (
          <BetPlacedButton pick={pick} />
        )}

        {/* v6.9.2: DraftKings one-tap deep-link (mobile + SNIPER only). */}
        {pick.verdictTier === "SNIPER" && (
          <DraftKingsButton dk={pick.dk} />
        )}

        {/* Matchup + date/time + Pick */}
        <div>
          <Link href={`/pick/${pick.gameId}`} className="text-sm font-medium text-foreground hover:text-gold-light">
            {pick.awayTeam} @ {pick.homeTeam}
          </Link>
          <div className="mt-0.5 text-[11px] tabular-nums text-muted-foreground" data-testid="card-datetime">
            {[fmtGameDate(pick.gameDate), fmtGameTime(pick.gameTimeEt)].filter(Boolean).join(" · ") || "Time TBD"}
          </div>
          {/* MLB-only: starting pitcher row */}
          {showPitcherRow && (
            <div className="mt-0.5 text-xs text-slate" data-testid="pitcher-row">
              SP: {awaySpName ?? "TBD"}{awaySpEra ? ` (${awaySpEra} ERA)` : ""} vs {homeSpName ?? "TBD"}{homeSpEra ? ` (${homeSpEra} ERA)` : ""}
            </div>
          )}
          {/* Soccer: league prefix + form row */}
          {showSoccerRow && (
            <div className="mt-0.5 text-xs text-slate" data-testid="soccer-league-row">
              {leaguePrefix}
              {(homeFormStr || awayFormStr) && (
                <span> Form: {awayFormStr ?? "—"} vs {homeFormStr ?? "—"}</span>
              )}
            </div>
          )}
          {/* NHL-only: starting goalie row */}
          {showGoalieRow && (
            <div className="mt-0.5 text-xs text-slate" data-testid="goalie-row">
              G: {awayGoalieName ?? "TBD"}{awayGoalieSvPct ? ` (${awayGoalieSvPct})` : ""} vs {homeGoalieName ?? "TBD"}{homeGoalieSvPct ? ` (${homeGoalieSvPct})` : ""}
            </div>
          )}
          <div className="mt-0.5 text-sm text-foreground/80">
            {pick.pickTeam} ML {fmtLine(pick.pickMl)}{" "}
            <span className="text-muted-foreground">{pick.pickBook ? `· ${pick.pickBook}` : ""}</span>
          </div>
        </div>

        {/* Final score row — prominent, silver, Barlow Condensed. */}
        {grade?.isFinal && grade.finalScoreLine && (
          <div
            className="font-display text-[17px] font-bold uppercase tracking-[0.06em] text-[#C0C6D0]"
            data-testid={`final-score-${pick.gameId}`}
          >
            {grade.finalScoreLine}
          </div>
        )}

        {/* Projected score (all sports) */}
        {showProjScore && (
          <div className="text-xs text-slate" data-testid="proj-score">
            Projected: {pick.awayTeam} {pick.projAwayScore.toFixed(1)} — {pick.homeTeam} {pick.projHomeScore.toFixed(1)}
          </div>
        )}

        {/* Spread + total markets — always rendered; rows show "No market"
            when a line isn't posted so the block never silently disappears. */}
        <div className="flex flex-col gap-1 rounded-lg border border-card-border bg-background/40 px-2.5 py-2" data-testid="markets-block">
          <SpreadRow market={pick.markets.spread} label={SPREAD_LABEL[pick.sport] ?? "SPR"} />
          <TotalRow market={pick.markets.total} />
        </div>

        {/* v6.9.1 five-source SignalsBar (Brand Board v3) */}
        <SignalsBar signals={pick.signals} />

        {/* Edge / EV subtitle */}
        <div className="text-[11px] tabular-nums text-muted-foreground">
          Edge {pick.edgePp ?? "—"}pp · EV {pick.evPer100 >= 0 ? "+" : ""}
          {pick.evPer100.toFixed(2)}/$100 · win {fmtPct(pick.pickWinProb, 0)} · conf {pick.confidence}
          {pick.alignmentSignalRaw !== null && ` · align ${pick.alignmentSignalRaw}pp`}
        </div>

        {/* Line-movement chip */}
        {openMl !== null && (
          <div className="flex items-center gap-1.5 text-[11px] tabular-nums">
            <span className="text-muted-foreground">
              Open {fmtLine(openMl)} → {fmtLine(pick.pickMl)}
            </span>
            {move.dir !== "flat" &&
              (move.dir === "down" ? (
                <ArrowDown className="h-3 w-3 text-tier-bonus" />
              ) : (
                <ArrowUp className="h-3 w-3 text-trap" />
              ))}
            {isSteam && (
              <span className="rounded bg-trap/15 px-1.5 py-0.5 font-display text-[10px] font-bold uppercase tracking-wider text-trap" data-testid="steam-badge">
                Steam
              </span>
            )}
          </div>
        )}

        {/* Closing Line Value chip / badge */}
        <ClvBadge pick={pick} />

        {/* Hit-rate footer */}
        <HitRateFooter tier={pick.verdictTier} />

        {/* Audio brief */}
        <JarvisPlayer pickId={pick.gameId} />

        {/* Why panel */}
        <WhyPanel pick={pick} />

        {/* Player props (collapsed) */}
        <PropsPanel sport={pick.sport} gameId={pick.gameId} gameDate={pick.gameDate} />
      </div>

      {/* Brand footer: scope mark + wordmark + date */}
      <div className="flex items-center justify-between gap-2 border-t border-gold/10 px-3.5 py-2">
        <div className="flex items-center gap-1.5">
          <span className="overflow-hidden rounded-full">
            <ScopeFull uid={`pf-${pick.gameId}`} size={16} />
          </span>
          <span className="font-display text-[9px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
            Elite Edge Analytics
          </span>
        </div>
        <span className="text-[9px] tabular-nums text-muted-foreground">
          {fmtGameDate(pick.gameDate) || ""}
        </span>
      </div>

      <span className="sr-only">{`bankroll ${fmtMoney(bankroll)}`}</span>
    </article>
  );
}
