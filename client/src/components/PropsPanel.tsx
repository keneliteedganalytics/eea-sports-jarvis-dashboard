import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { fmtLine, TIER_META } from "@/lib/format";
import type { Verdict } from "@/lib/types";

export interface PropRow {
  gameId: string;
  sport: string;
  playerName: string;
  team: string;
  market: string;
  line: number;
  overPrice: number;
  underPrice: number;
  book: string;
  modelProb: number | null;
  edgePp: number | null;
  tier: string | null;
  side: string | null;
  uncalibrated: boolean;
}

interface PropsResponse {
  sport: string;
  date: string;
  props: PropRow[];
}

const MARKET_LABEL: Record<string, string> = {
  batter_home_runs: "HR",
  batter_hits: "Hits",
  batter_total_bases: "TB",
  pitcher_strikeouts: "Ks",
  player_goal_scorer_anytime: "Anytime G",
  player_shots_on_goal: "SOG",
  player_points: "Pts",
  player_rebounds: "Reb",
  player_assists: "Ast",
  player_threes: "3PM",
};

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

export function PropsPanel({ sport, gameId, gameDate }: { sport: string; gameId: string; gameDate: string }) {
  const [open, setOpen] = useState(false);

  const { data } = useQuery<PropsResponse>({
    queryKey: [`/api/props?sport=${sport}&date=${gameDate}`],
    enabled: open,
  });

  const rows = (data?.props ?? []).filter((p) => p.gameId === gameId).slice(0, 6);

  return (
    <div className="border-t border-card-border pt-2" data-testid={`props-panel-${gameId}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-gold"
        data-testid={`props-toggle-${gameId}`}
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        Player props
      </button>

      {open && (
        <div className="mt-2 flex flex-col gap-1.5">
          {rows.length === 0 && (
            <div className="text-[11px] text-muted-foreground">No props posted for this game yet.</div>
          )}
          {rows.map((p, i) => (
            <div key={`${p.playerName}-${p.market}-${i}`} className="flex items-center gap-2 text-[11px]" data-testid="prop-row">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gold/15 text-[9px] font-bold text-gold">
                {initials(p.playerName)}
              </span>
              <span className="min-w-0 flex-1 truncate text-foreground/85">
                {p.playerName} <span className="text-muted-foreground">{MARKET_LABEL[p.market] ?? p.market}</span>
              </span>
              <span className="tabular-nums text-foreground/80">
                {p.line} <span className="text-muted-foreground">o{fmtLine(p.overPrice)}/u{fmtLine(p.underPrice)}</span>
              </span>
              {p.tier && p.tier !== "PASS" && p.edgePp !== null ? (
                <span className="font-semibold tabular-nums" style={{ color: TIER_META[p.tier as Verdict]?.hex ?? "#8892A0" }}>
                  {p.edgePp >= 0 ? "+" : ""}
                  {p.edgePp}pp
                </span>
              ) : (
                p.uncalibrated && <span className="text-[9px] uppercase tracking-wider text-muted-foreground">uncal</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
