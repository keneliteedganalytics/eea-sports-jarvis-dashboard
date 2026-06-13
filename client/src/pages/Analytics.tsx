import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { TIER_META, fmtUnits, fmtMoney } from "@/lib/format";
import type { AnalyticsPayload, ParlayAnalyticsPayload, PropAnalyticsPayload, Verdict } from "@/lib/types";

const AXIS = "#8892A0";
const GRID = "#1d2740";

function tierHex(tier: string): string {
  return TIER_META[tier as Verdict]?.hex ?? "#8892A0";
}

export default function Analytics() {
  const [sport, setSport] = useState("ALL");
  const [tier, setTier] = useState("ALL");
  const [since, setSince] = useState("");

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (sport !== "ALL") p.set("sport", sport);
    if (tier !== "ALL") p.set("tier", tier);
    if (since) p.set("since", since);
    const s = p.toString();
    return s ? `?${s}` : "";
  }, [sport, tier, since]);

  const { data } = useQuery<AnalyticsPayload>({ queryKey: [`/api/analytics${qs}`] });

  const propsQs = useMemo(() => {
    const p = new URLSearchParams();
    if (sport !== "ALL") p.set("sport", sport);
    if (since) p.set("since", since);
    const s = p.toString();
    return s ? `?${s}` : "";
  }, [sport, since]);
  const { data: props } = useQuery<PropAnalyticsPayload>({ queryKey: [`/api/props/analytics${propsQs}`] });

  // v6.7.9: virtual parlay (paper portfolio) aggregate. Not filtered — it's a
  // standalone tracker across all dates/sports.
  const { data: parlays } = useQuery<ParlayAnalyticsPayload>({ queryKey: ["/api/parlays/analytics"] });

  return (
    <div className="space-y-6" data-testid="analytics-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Analytics</h1>
        <p className="text-xs text-muted-foreground">
          Performance across the graded book — win rate by tier, ROI by sport, closing-line value, and drawdown.
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3" data-testid="analytics-filters">
        <Filter label="Sport" value={sport} options={data?.available.sports ?? ["ALL"]} onChange={setSport} />
        <Filter label="Tier" value={tier} options={data?.available.tiers ?? ["ALL"]} onChange={setTier} />
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Since</label>
          <input
            type="date"
            value={since}
            onChange={(e) => setSince(e.target.value)}
            className="rounded-lg border border-card-border bg-navy-card px-2 py-1.5 text-xs text-foreground"
            data-testid="filter-since"
          />
        </div>
        {(sport !== "ALL" || tier !== "ALL" || since) && (
          <button
            onClick={() => {
              setSport("ALL");
              setTier("ALL");
              setSince("");
            }}
            className="rounded-lg border border-card-border px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground"
            data-testid="filter-reset"
          >
            Reset
          </button>
        )}
      </div>

      {/* KPI cards */}
      {data && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6" data-testid="kpi-cards">
          <Kpi label="Total bets" value={String(data.kpis.totalBets)} />
          <Kpi label="Win rate" value={`${data.kpis.winRatePct.toFixed(1)}%`} good={data.kpis.winRatePct >= 50} />
          <Kpi label="ROI" value={`${data.kpis.roiPct >= 0 ? "+" : ""}${data.kpis.roiPct.toFixed(1)}%`} good={data.kpis.roiPct >= 0} />
          <Kpi label="Net units" value={fmtUnits(data.kpis.netUnits)} good={data.kpis.netUnits >= 0} />
          <Kpi label="CLV" value={`${data.kpis.clvPct >= 0 ? "+" : ""}${data.kpis.clvPct.toFixed(1)}%`} good={data.kpis.clvPct >= 0} />
          <Kpi label="Max drawdown" value={fmtUnits(data.kpis.maxDrawdownUnits)} good={false} />
        </div>
      )}

      {/* v6.7.7: graded record by pick kind (game lines vs player props) */}
      {data && data.byKind && (
        <Panel title="By pick kind">
          <div className="grid grid-cols-2 gap-3" data-testid="analytics-bykind">
            {data.byKind.map((k) => (
              <div key={k.kind} className="rounded-lg border border-card-border bg-background/30 p-3" data-testid={`bykind-${k.kind}`}>
                <div className="font-display text-[11px] font-bold uppercase tracking-wider text-gold-dark">
                  {k.kind === "game" ? "Game lines" : "Player props"}
                </div>
                <div className="mt-1 text-sm text-foreground">
                  {k.bets} played · {k.wins}-{k.losses}{k.pushes ? `-${k.pushes}` : ""}
                </div>
                <div className="mt-0.5 flex items-center gap-3 text-xs">
                  <span className={k.netUnits >= 0 ? "text-tier-bonus" : "text-trap"}>{fmtUnits(k.netUnits)}</span>
                  <span className={k.roiPct >= 0 ? "text-tier-bonus" : "text-trap"}>
                    {k.roiPct >= 0 ? "+" : ""}{k.roiPct.toFixed(1)}% ROI
                  </span>
                </div>
              </div>
            ))}
          </div>
          {data.byTier && data.byTier.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2" data-testid="analytics-bytier">
              {data.byTier.map((t) => (
                <span
                  key={t.tier}
                  className="rounded-full border border-card-border bg-background/40 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider"
                  style={{ color: tierHex(t.tier) }}
                >
                  {t.tier} · {t.bets} played
                </span>
              ))}
            </div>
          )}
        </Panel>
      )}

      {/* v6.7.9: virtual parlays — paper portfolio of $100-per-game SNIPER parlays */}
      {parlays && parlays.total_parlays > 0 && (
        <Panel title="Virtual parlays">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6" data-testid="analytics-parlays">
            <Kpi label="Parlays" value={String(parlays.total_parlays)} />
            <Kpi label="Cashed" value={String(parlays.won)} good />
            <Kpi label="Busted" value={String(parlays.busted)} good={false} />
            <Kpi label="Win rate" value={`${parlays.win_rate_pct.toFixed(1)}%`} good={parlays.win_rate_pct >= 50} />
            <Kpi
              label="Paper P/L"
              value={`${parlays.total_pl_dollars >= 0 ? "+" : "−"}${fmtMoney(Math.abs(parlays.total_pl_dollars))}`}
              good={parlays.total_pl_dollars >= 0}
            />
            <Kpi
              label="ROI"
              value={`${parlays.roi_pct >= 0 ? "+" : ""}${parlays.roi_pct.toFixed(1)}%`}
              good={parlays.roi_pct >= 0}
            />
          </div>
          {parlays.by_day.length > 0 && (
            <div className="mt-3 overflow-x-auto" data-testid="analytics-parlays-by-day">
              <table className="w-full text-left text-[11px]">
                <thead>
                  <tr className="text-muted-foreground">
                    <th className="py-1 pr-3">Day</th>
                    <th className="py-1 pr-3">Parlays</th>
                    <th className="py-1 pr-3">Cashed</th>
                    <th className="py-1 pr-3">Busted</th>
                    <th className="py-1">P/L</th>
                  </tr>
                </thead>
                <tbody>
                  {parlays.by_day.map((d) => (
                    <tr key={d.day} className="border-t border-card-border">
                      <td className="py-1.5 pr-3 font-medium text-foreground">{d.day}</td>
                      <td className="py-1.5 pr-3 tabular-nums">{d.parlays}</td>
                      <td className="py-1.5 pr-3 tabular-nums text-tier-bonus">{d.won}</td>
                      <td className="py-1.5 pr-3 tabular-nums text-trap">{d.busted}</td>
                      <td className={`py-1.5 tabular-nums ${d.pl_dollars >= 0 ? "text-tier-bonus" : "text-trap"}`}>
                        {d.pl_dollars >= 0 ? "+" : "−"}{fmtMoney(Math.abs(d.pl_dollars))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}

      {/* v6.7.7: the passed-on pile — what the engine evaluated but did not play */}
      {data && data.passSummary && (
        <Panel title="Passes breakdown">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3" data-testid="analytics-passes">
            <Kpi label="Evaluated" value={String(data.passSummary.totalEvaluated)} />
            <Kpi label="Passed on" value={String(data.passSummary.passed)} />
            <Kpi
              label="Pass rate"
              value={
                data.passSummary.totalEvaluated > 0
                  ? `${Math.round((data.passSummary.passed / data.passSummary.totalEvaluated) * 100)}%`
                  : "—"
              }
              good={false}
            />
          </div>
          {Object.keys(data.passSummary.passReasonBreakdown).length > 0 && (
            <div className="mt-3 space-y-1.5" data-testid="analytics-pass-reasons">
              {Object.entries(data.passSummary.passReasonBreakdown)
                .sort((a, b) => b[1] - a[1])
                .map(([reason, n]) => {
                  const max = Math.max(...Object.values(data.passSummary.passReasonBreakdown));
                  const pct = max > 0 ? Math.round((n / max) * 100) : 0;
                  return (
                    <div key={reason} className="flex items-center gap-2" data-testid={`pass-reason-${reason}`}>
                      <span className="w-36 shrink-0 truncate text-[11px] uppercase tracking-wider text-muted-foreground">
                        {reason.replace(/_/g, " ")}
                      </span>
                      <div className="h-3 flex-1 overflow-hidden rounded-full bg-background/40">
                        <div className="h-full rounded-full bg-gold" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="w-8 shrink-0 text-right text-[11px] tabular-nums text-foreground">{n}</span>
                    </div>
                  );
                })}
            </div>
          )}
        </Panel>
      )}

      {/* Closing Line Value — mean CLV %, positive rate, mean by tier */}
      {data && (
        <Panel title="Closing line value">
          {data.clv.captured === 0 ? (
            <div className="text-xs text-muted-foreground" data-testid="clv-empty">
              No closing lines captured yet — CLV populates once picks lock at game start.
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" data-testid="clv-cards">
              <Kpi
                label="Mean CLV"
                value={`${data.clv.meanPct >= 0 ? "+" : ""}${data.clv.meanPct.toFixed(1)}%`}
                good={data.clv.meanPct >= 0}
              />
              <Kpi
                label="Positive rate"
                value={`${data.clv.positiveRatePct.toFixed(0)}%`}
                good={data.clv.positiveRatePct >= 50}
              />
              {["SNIPER", "EDGE", "RECON"].map((t) => {
                const row = data.clv.byTier.find((r) => r.tier === t);
                return (
                  <Kpi
                    key={t}
                    label={`${t} CLV`}
                    value={row ? `${row.meanPct >= 0 ? "+" : ""}${row.meanPct.toFixed(1)}%` : "—"}
                    good={row ? row.meanPct >= 0 : undefined}
                  />
                );
              })}
            </div>
          )}
        </Panel>
      )}

      {/* Win rate by tier + ROI by sport */}
      <div className="grid gap-4 lg:grid-cols-2">
        {data && data.winRateByTier.length > 0 && (
          <Panel title="Win rate by tier">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={data.winRateByTier} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="tier" stroke={AXIS} fontSize={10} tickLine={false} />
                <YAxis stroke={AXIS} fontSize={10} tickLine={false} unit="%" domain={[0, 100]} />
                <Tooltip
                  contentStyle={{ background: "#0f1729", border: "1px solid #1d2740", borderRadius: 8, fontSize: 12 }}
                  formatter={(v: number, _n, p) => [`${v}% (${p.payload.wins}-${p.payload.losses})`, "Win rate"]}
                />
                <Bar dataKey="pct" radius={[4, 4, 0, 0]}>
                  {data.winRateByTier.map((r) => (
                    <Cell key={r.tier} fill={tierHex(r.tier)} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Panel>
        )}

        {data && data.roiBySport.length > 0 && (
          <Panel title="ROI by sport">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={data.roiBySport} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="sport" stroke={AXIS} fontSize={10} tickLine={false} />
                <YAxis stroke={AXIS} fontSize={10} tickLine={false} unit="%" />
                <Tooltip
                  contentStyle={{ background: "#0f1729", border: "1px solid #1d2740", borderRadius: 8, fontSize: 12 }}
                  formatter={(v: number, _n, p) => [`${v}% · ${fmtUnits(p.payload.netUnits)} · ${p.payload.bets} bets`, "ROI"]}
                />
                <Bar dataKey="roiPct" radius={[4, 4, 0, 0]}>
                  {data.roiBySport.map((r) => (
                    <Cell key={r.sport} fill={r.roiPct >= 0 ? "#4ADE80" : "#FF8A47"} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Panel>
        )}
      </div>

      {/* CLV trend + drawdown */}
      {data && data.trend.length > 0 && (
        <Panel title="CLV trend & running drawdown">
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={data.trend} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="date" stroke={AXIS} fontSize={10} tickLine={false} />
              <YAxis stroke={AXIS} fontSize={10} tickLine={false} />
              <Tooltip contentStyle={{ background: "#0f1729", border: "1px solid #1d2740", borderRadius: 8, fontSize: 12 }} />
              <Line type="monotone" dataKey="cumUnits" name="Net units" stroke="#C9A227" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="clv" name="CLV tally" stroke="#5BC0EB" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="drawdownUnits" name="Drawdown" stroke="#FF8A47" strokeWidth={1.5} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </Panel>
      )}

      {/* Hit-rate heatmap */}
      {data && data.heatmap.length > 0 && (
        <Panel title="Hit-rate heatmap (tier × window)">
          <Heatmap cells={data.heatmap} />
        </Panel>
      )}

      {/* Player props */}
      {props && (
        <Panel title="Player props">
          {props.totalPicks === 0 ? (
            <div className="text-xs text-muted-foreground" data-testid="props-analytics-empty">
              No graded prop picks yet — this section populates once player props are settled.
            </div>
          ) : (
            <div className="space-y-4" data-testid="props-analytics">
              {props.sampleWarning && (
                <div
                  className="rounded-lg border border-gold/30 bg-gold/[0.06] px-3 py-2 text-[11px] text-gold-dark"
                  data-testid="props-sample-warning"
                >
                  Small sample — under 100 graded props. Treat these breakdowns as directional, not conclusive.
                </div>
              )}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                <Kpi label="Prop picks" value={String(props.totalPicks)} />
                <Kpi label="Record" value={`${props.record.wins}-${props.record.losses}-${props.record.pushes}`} />
                <Kpi label="ROI" value={`${props.roiPct >= 0 ? "+" : ""}${props.roiPct.toFixed(1)}%`} good={props.roiPct >= 0} />
                <Kpi label="Net units" value={fmtUnits(props.netUnits)} good={props.netUnits >= 0} />
                <Kpi label="Mean CLV" value={`${props.clvMeanPct >= 0 ? "+" : ""}${props.clvMeanPct.toFixed(1)}%`} good={props.clvMeanPct >= 0} />
                <Kpi
                  label={`Calibration (${props.calibration.qualifying})`}
                  value={props.calibration.qualifying > 0 ? `${props.calibration.hitRatePct.toFixed(1)}%` : "—"}
                  good={props.calibration.hitRatePct >= 50}
                />
              </div>
              {props.byMarket.length > 0 && (
                <div className="overflow-x-auto" data-testid="props-by-market">
                  <table className="w-full text-left text-[11px]">
                    <thead>
                      <tr className="text-muted-foreground">
                        <th className="py-1 pr-3">Market</th>
                        <th className="py-1 pr-3">Bets</th>
                        <th className="py-1 pr-3">W-L-P</th>
                        <th className="py-1 pr-3">ROI</th>
                        <th className="py-1">Net units</th>
                      </tr>
                    </thead>
                    <tbody>
                      {props.byMarket.map((m) => (
                        <tr key={m.market_type} className="border-t border-card-border">
                          <td className="py-1.5 pr-3 font-medium text-foreground">{m.market_type}</td>
                          <td className="py-1.5 pr-3 tabular-nums">{m.bets}</td>
                          <td className="py-1.5 pr-3 tabular-nums">{m.wins}-{m.losses}-{m.pushes}</td>
                          <td className={`py-1.5 pr-3 tabular-nums ${m.roiPct >= 0 ? "text-tier-bonus" : "text-trap"}`}>
                            {m.roiPct >= 0 ? "+" : ""}{m.roiPct.toFixed(1)}%
                          </td>
                          <td className={`py-1.5 tabular-nums ${m.netUnits >= 0 ? "text-tier-bonus" : "text-trap"}`}>
                            {fmtUnits(m.netUnits)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {props.byPlayer.length > 0 && (
                <div className="overflow-x-auto" data-testid="props-by-player">
                  <h3 className="mb-1 font-display text-[11px] font-bold uppercase tracking-[0.16em] text-gold-dark">Top players</h3>
                  <table className="w-full text-left text-[11px]">
                    <thead>
                      <tr className="text-muted-foreground">
                        <th className="py-1 pr-3">Player</th>
                        <th className="py-1 pr-3">Bets</th>
                        <th className="py-1 pr-3">W-L-P</th>
                        <th className="py-1">Net units</th>
                      </tr>
                    </thead>
                    <tbody>
                      {props.byPlayer.map((p) => (
                        <tr key={p.player_name} className="border-t border-card-border">
                          <td className="py-1.5 pr-3 font-medium text-foreground">{p.player_name}</td>
                          <td className="py-1.5 pr-3 tabular-nums">{p.bets}</td>
                          <td className="py-1.5 pr-3 tabular-nums">{p.wins}-{p.losses}-{p.pushes}</td>
                          <td className={`py-1.5 tabular-nums ${p.netUnits >= 0 ? "text-tier-bonus" : "text-trap"}`}>
                            {fmtUnits(p.netUnits)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {props.byLineDistance.some((b) => b.decided > 0) && (
                <div className="flex flex-wrap gap-3" data-testid="props-by-line-distance">
                  {props.byLineDistance.map((b) => (
                    <div key={b.label} className="rounded-lg border border-card-border bg-navy-card px-3 py-2 text-[11px]">
                      <div className="text-muted-foreground">{b.label}</div>
                      <div className="font-bold tabular-nums text-foreground">
                        {b.decided > 0 ? `${b.hitRatePct.toFixed(0)}%` : "—"}
                        <span className="ml-1 font-normal text-muted-foreground">({b.decided})</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}

function Heatmap({ cells }: { cells: AnalyticsPayload["heatmap"] }) {
  const tiers = [...new Set(cells.map((c) => c.tier))];
  const windows = [...new Set(cells.map((c) => c.windowDays))].sort((a, b) => a - b);
  const cellOf = (t: string, w: number) => cells.find((c) => c.tier === t && c.windowDays === w);

  // Green-up scale: 35%→red, 50%→neutral, 65%+→green.
  const hex = (pct: number) => {
    const clamped = Math.max(35, Math.min(65, pct));
    const t = (clamped - 35) / 30; // 0..1
    const r = Math.round(255 + t * (74 - 255));
    const g = Math.round(138 + t * (222 - 138));
    const b = Math.round(71 + t * (128 - 71));
    return `rgb(${r},${g},${b})`;
  };

  return (
    <div className="overflow-x-auto" data-testid="hit-rate-heatmap">
      <table className="w-full border-separate border-spacing-1 text-center text-[11px]">
        <thead>
          <tr>
            <th className="text-left text-muted-foreground">Tier</th>
            {windows.map((w) => (
              <th key={w} className="text-muted-foreground">{w}d</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tiers.map((t) => (
            <tr key={t}>
              <td className="text-left font-medium" style={{ color: tierHex(t) }}>{t}</td>
              {windows.map((w) => {
                const c = cellOf(t, w);
                return (
                  <td
                    key={w}
                    className="rounded px-2 py-1.5 font-semibold tabular-nums text-navy-bg"
                    style={{ backgroundColor: c ? hex(c.pct) : "#1d2740" }}
                    title={c ? `${c.pct}% over ${c.decided} decided` : "no data"}
                  >
                    {c ? `${c.pct}%` : "—"}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Filter({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-lg border border-card-border bg-navy-card px-2 py-1.5 text-xs text-foreground"
        data-testid={`filter-${label.toLowerCase()}`}
      >
        {options.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    </div>
  );
}

function Kpi({ label, value, good }: { label: string; value: string; good?: boolean }) {
  const tone = good === undefined ? "text-foreground" : good ? "text-tier-bonus" : "text-trap";
  return (
    <div className="rounded-xl border border-card-border bg-navy-card p-3" data-testid={`kpi-${label.toLowerCase().replace(/\s+/g, "-")}`}>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`mt-0.5 text-lg font-bold tabular-nums ${tone}`}>{value}</div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-card-border bg-navy-card p-4">
      <div className="mb-3 text-xs font-bold uppercase tracking-wider text-muted-foreground">{title}</div>
      {children}
    </div>
  );
}
