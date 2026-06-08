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
import { TIER_META, fmtUnits } from "@/lib/format";
import type { AnalyticsPayload, Verdict } from "@/lib/types";

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
