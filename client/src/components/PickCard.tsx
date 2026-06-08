import { Link } from "wouter";
import { ArrowDown, ArrowUp } from "lucide-react";
import { TierPill } from "./TierPill";
import { SignalBars } from "./SignalBars";
import { HitRateFooter } from "./HitRateFooter";
import { JarvisPlayer } from "./JarvisPlayer";
import { WhyPanel } from "./WhyPanel";
import { SpreadRow } from "./SpreadRow";
import { TotalRow } from "./TotalRow";
import { PropsPanel } from "./PropsPanel";
import { fmtLine, fmtMoney, fmtPct, fmtUnits, lineMovement } from "@/lib/format";
import type { BuiltPick } from "@/lib/types";

const STEAM_CENTS = 10;

const SPREAD_LABEL: Record<string, string> = { mlb: "RL", nhl: "PL", nba: "SPR" };

export function PickCard({ pick, bankroll }: { pick: BuiltPick; bankroll: number }) {
  const openMl = pick.pickSide === "home" ? pick.openHomeMl : pick.openAwayMl;
  const move = lineMovement(openMl, pick.pickMl);
  const isSteam = move.cents >= STEAM_CENTS;

  // Use real public/sharp pcts from the server; fall back to null (renders as —)
  const publicPct = pick.publicPct;
  const sharpPct = pick.sharpPct;
  const prismPct = pick.polymarket.found ? pick.polymarket.pct ?? null : null;
  const prismReason = !pick.polymarket.found ? (pick.polymarket.reason ?? "No Polymarket market available") : null;

  // MLB pitcher row data
  const isMLB = pick.sport === "mlb";
  const awaySpName = pick.awaySp?.available === false ? "TBD" : (pick.awaySp?.pitcher ?? null);
  const homeSpName = pick.homeSp?.available === false ? "TBD" : (pick.homeSp?.pitcher ?? null);
  const awaySpEra = pick.awaySp?.era != null ? pick.awaySp.era.toFixed(2) : null;
  const homeSpEra = pick.homeSp?.era != null ? pick.homeSp.era.toFixed(2) : null;
  const showPitcherRow = isMLB && (awaySpName !== null || homeSpName !== null);

  // Projected score line — shown on every sport when both scores available
  const showProjScore = pick.projAwayScore != null && pick.projHomeScore != null;

  return (
    <article
      className="flex flex-col gap-3 rounded-xl border border-card-border bg-navy-card p-4 hover-elevate"
      data-testid={`pick-card-${pick.gameId}`}
    >
      {/* 1. Tier pill */}
      <div className="flex items-center gap-1.5">
        <TierPill tier={pick.verdictTier} />
        {pick.topPlay && (
          <span className="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider" style={{ color: "#0A1628", backgroundColor: "#F4D77A" }} data-testid="top-play-badge">
            Top Play
          </span>
        )}
        <span className="flex-1" />
        {pick.subSampleWarning && (
          <span
            className="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider"
            style={{ color: "#0A1628", backgroundColor: "#F4D77A" }}
            data-testid="sub25-badge"
            title={pick.subSampleDetails ?? "Sub-25 IP starter — judgment call"}
          >
            Sub-25 IP
          </span>
        )}
        {pick.phantomEdge && (
          <span className="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider" style={{ color: "#0A1628", backgroundColor: "#F4D77A" }} data-testid="data-gap-badge">
            Data Gap
          </span>
        )}
        {pick.trapSignal && (
          <span className="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider" style={{ color: "#FF8A47", backgroundColor: "#FF8A4715" }}>
            Trap
          </span>
        )}
      </div>

      {/* 2. Units chip (large, gold) */}
      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-bold tabular-nums text-gold" data-testid={`units-${pick.gameId}`}>
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

      {/* 3. Matchup + 4. Pick */}
      <div>
        <Link href={`/pick/${pick.gameId}`} className="text-sm font-medium text-foreground hover:text-gold">
          {pick.awayTeam} @ {pick.homeTeam} · {pick.gameTimeEt}
        </Link>
        {/* MLB-only: starting pitcher row */}
        {showPitcherRow && (
          <div className="mt-0.5 text-xs text-zinc-400" data-testid="pitcher-row">
            SP: {awaySpName ?? "TBD"}{awaySpEra ? ` (${awaySpEra} ERA)` : ""} vs {homeSpName ?? "TBD"}{homeSpEra ? ` (${homeSpEra} ERA)` : ""}
          </div>
        )}
        <div className="mt-0.5 text-sm text-foreground/80">
          {pick.pickTeam} ML {fmtLine(pick.pickMl)}{" "}
          <span className="text-muted-foreground">{pick.pickBook ? `· ${pick.pickBook}` : ""}</span>
        </div>
      </div>

      {/* 4b. Projected score (all sports) */}
      {showProjScore && (
        <div className="text-xs text-zinc-400" data-testid="proj-score">
          Projected: {pick.awayTeam} {pick.projAwayScore.toFixed(1)} — {pick.homeTeam} {pick.projHomeScore.toFixed(1)}
        </div>
      )}

      {/* 4c. Spread + total markets */}
      {(pick.markets?.spread?.available || pick.markets?.total?.available) && (
        <div className="flex flex-col gap-1 rounded-lg border border-card-border bg-background/40 px-2.5 py-2" data-testid="markets-block">
          <SpreadRow market={pick.markets.spread} label={SPREAD_LABEL[pick.sport] ?? "SPR"} />
          <TotalRow market={pick.markets.total} />
        </div>
      )}

      {/* 5. 3-bar */}
      <SignalBars publicPct={publicPct} sharpPct={sharpPct} prismPct={prismPct} prismReason={prismReason} />

      {/* 6. Edge / EV subtitle */}
      <div className="text-[11px] tabular-nums text-muted-foreground">
        Edge {pick.edgePp ?? "—"}pp · EV {pick.evPer100 >= 0 ? "+" : ""}
        {pick.evPer100.toFixed(2)}/$100 · win {fmtPct(pick.pickWinProb, 0)} · conf {pick.confidence}
        {pick.alignmentSignalRaw !== null && ` · align ${pick.alignmentSignalRaw}pp`}
      </div>

      {/* 7. Line-movement chip */}
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
            <span className="rounded bg-trap/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-trap" data-testid="steam-badge">
              Steam
            </span>
          )}
        </div>
      )}

      {/* 8. Hit-rate footer */}
      <HitRateFooter tier={pick.verdictTier} />

      {/* 9. Audio brief */}
      <JarvisPlayer pickId={pick.gameId} />

      {/* 10. Why panel */}
      <WhyPanel pick={pick} />

      {/* 11. Player props (collapsed) */}
      <PropsPanel sport={pick.sport} gameId={pick.gameId} gameDate={pick.gameDate} />

      <span className="sr-only">{`bankroll ${fmtMoney(bankroll)}`}</span>
    </article>
  );
}
