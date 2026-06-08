import { useQuery } from "@tanstack/react-query";
import { Link, useRoute } from "wouter";
import { ArrowLeft } from "lucide-react";
import { TierPill } from "@/components/TierPill";
import { SignalBars } from "@/components/SignalBars";
import { HitRateFooter } from "@/components/HitRateFooter";
import { JarvisPlayer } from "@/components/JarvisPlayer";
import { WhyPanel } from "@/components/WhyPanel";
import { fmtLine, fmtMoney, fmtPct, fmtUnits } from "@/lib/format";
import type { BuiltPick } from "@/lib/types";

export default function PickDetail() {
  const [, params] = useRoute("/pick/:id");
  const id = params?.id ?? "";
  const { data, isLoading, isError } = useQuery<BuiltPick>({ queryKey: ["/api/mlb/pick", id] });

  return (
    <div className="space-y-5">
      <Link href="/" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-gold" data-testid="link-back">
        <ArrowLeft className="h-3.5 w-3.5" /> Back to board
      </Link>

      {isLoading && <div className="h-96 animate-pulse rounded-xl border border-card-border bg-navy-card" />}
      {isError && (
        <div className="rounded-xl border border-card-border bg-navy-card p-8 text-center text-sm text-muted-foreground">
          Pick not found.
        </div>
      )}

      {data && (
        <div className="space-y-5">
          <div className="rounded-xl border border-card-border bg-navy-card p-5">
            <div className="flex items-center justify-between">
              <TierPill tier={data.verdictTier} />
              {data.trapSignal && (
                <span
                  className="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider"
                  style={{ color: "#FF8A47", backgroundColor: "#FF8A4715" }}
                >
                  Trap
                </span>
              )}
            </div>

            <h1 className="mt-3 text-xl font-bold tracking-tight">
              {data.awayTeam} @ {data.homeTeam}
            </h1>
            <p className="text-xs text-muted-foreground">
              {data.venue} · {data.gameTimeEt} · {data.gameDate}
            </p>

            <div className="mt-4 flex items-baseline gap-3">
              <span className="text-4xl font-bold tabular-nums text-gold" data-testid="detail-units">
                {data.phantomEdge ? "—" : fmtUnits(data.units)}
              </span>
              <div className="text-sm text-foreground/80">
                <div className="font-medium">
                  {data.pickTeam} ML {fmtLine(data.pickMl)} {data.pickBook ? `· ${data.pickBook}` : ""}
                </div>
                <div className="text-xs text-muted-foreground tabular-nums">
                  {data.phantomEdge
                    ? "data gap · no play"
                    : data.kellyStakeDollars > 0
                      ? `${fmtMoney(data.kellyStakeDollars)} stake`
                      : "no stake"}
                  {!data.phantomEdge && data.halfCut && " · half (juice)"}
                  {!data.phantomEdge && data.trimmed && " · trimmed (cap)"}
                </div>
              </div>
            </div>

            <div className="mt-4">
              <SignalBars
                publicPct={(data.pickImpliedProb ?? 0) * 100}
                sharpPct={(data.pickWinProb ?? 0) * 100}
                prismPct={data.polymarket.found ? data.polymarket.pct ?? null : null}
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Stat label="Model win %" value={fmtPct(data.pickWinProb, 1)} />
            <Stat label="Implied %" value={fmtPct(data.pickImpliedProb, 1)} />
            <Stat label="Edge" value={`${data.edgePp ?? "—"}pp`} />
            <Stat label="EV / $100" value={`${data.evPer100 >= 0 ? "+" : ""}${data.evPer100.toFixed(2)}`} />
            <Stat label="Fair line" value={fmtLine(data.fairMl)} />
            <Stat label="Confidence" value={`${data.confidence}/99`} />
            <Stat label="Proj score" value={`${data.projAwayScore.toFixed(1)} — ${data.projHomeScore.toFixed(1)}`} />
            <Stat label="Expected total" value={data.expectedTotal.toFixed(1)} />
          </div>

          {/* Line history (open → current) */}
          <div className="rounded-xl border border-card-border bg-navy-card p-4">
            <div className="mb-2 text-xs font-bold uppercase tracking-wider text-muted-foreground">Line history</div>
            <div className="grid grid-cols-2 gap-3 text-sm tabular-nums">
              <LineRow team={data.awayTeam} open={data.openAwayMl} current={data.awayMl} />
              <LineRow team={data.homeTeam} open={data.openHomeMl} current={data.homeMl} />
            </div>
          </div>

          <HitRateFooter tier={data.verdictTier} />
          <JarvisPlayer pickId={data.gameId} />
          <WhyPanel pick={data} />

          <span className="sr-only">{`pitchers ${data.awayPitcher ?? "TBD"} vs ${data.homePitcher ?? "TBD"}`}</span>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-card-border bg-navy-card p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-base font-medium tabular-nums text-foreground">{value}</div>
    </div>
  );
}

function LineRow({ team, open, current }: { team: string; open: number | null; current: number | null }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{team}</div>
      <div className="text-foreground">
        {fmtLine(open)} <span className="text-muted-foreground">→</span> {fmtLine(current)}
      </div>
    </div>
  );
}
