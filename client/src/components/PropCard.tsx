import { ScopeFull } from "./ScopeFull";
import { fmtLine } from "@/lib/format";
import type { PropBoardItem, PropHitRates, Verdict } from "@/lib/types";

// Brand Board v3 prop card. Mirrors PickCard's header/footer anatomy (scope mark +
// tier wordmark + tier pill) but renders prop-specific content: player + market
// line, the simulation summary (median / edge / over%), a hit-rate row, the
// "100% Club" gold badge, an inline SVG distribution sketch with a vertical line
// at the posted prop line, and the best-book badge.

const TIER_HEX: Record<string, string> = {
  SNIPER: "#E8C14A",
  EDGE: "#C9A227",
  RECON: "#9A7B1E",
  PASS: "#6B7A99",
};

const TIER_WORDMARK: Record<string, string> = {
  SNIPER: "EE SNIPER",
  EDGE: "EE EDGE",
  RECON: "EE RECON",
  PASS: "EE RECON",
};

const BOOK_LABEL: Record<string, string> = {
  draftkings: "DraftKings",
  fanduel: "FanDuel",
  betmgm: "BetMGM",
  caesars: "Caesars",
  pointsbetus: "PointsBet",
  betrivers: "BetRivers",
  williamhill_us: "Caesars",
  bovada: "Bovada",
  mybookieag: "MyBookie",
};

function bookLabel(book: string | null): string {
  if (!book) return "";
  return BOOK_LABEL[book] ?? book.replace(/_/g, " ");
}

function parseHitRates(json: string | null): PropHitRates | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as PropHitRates;
  } catch {
    return null;
  }
}

function pct(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

// v6.7.3 live-state palette. While a prop is in progress the card glows green
// (clearing) or red (busted); once the game is final and the prop won, it shows
// a gold PAID badge and a dollar payout footer ($375/unit).
const LIVE_GREEN = "#4ADE80";
const LIVE_RED = "#EF4444";
const PROP_UNIT_DOLLARS = 375;

// Visual treatment for a card from its live disposition. Returns the border
// color + box-shadow glow that override the tier border, or null for pending
// (the default tier styling stands).
function liveSkin(state: PropBoardItem["liveState"]): { border: string; glow: string } | null {
  switch (state) {
    case "live_clear":
      return { border: LIVE_GREEN, glow: `0 0 0 1px ${LIVE_GREEN}55, 0 0 16px ${LIVE_GREEN}33` };
    case "paid":
      return { border: LIVE_GREEN, glow: `0 0 0 1px ${LIVE_GREEN}66, 0 0 18px ${LIVE_GREEN}44` };
    case "busted":
      return { border: LIVE_RED, glow: `0 0 0 1px ${LIVE_RED}55, 0 0 16px ${LIVE_RED}33` };
    default:
      return null;
  }
}

// A compact distribution sketch from the stored percentiles. We don't ship raw
// trial samples to the board, so this draws a p25–p75 box with median + mean
// markers and a gold vertical line at the posted prop line — an honest summary
// of the simulated spread rather than a fabricated histogram.
function DistSketch({ item }: { item: PropBoardItem }) {
  const p25 = item.sim_p25;
  const p75 = item.sim_p75;
  const median = item.sim_median;
  const mean = item.sim_mean;
  if (p25 == null || p75 == null || median == null) return null;

  const lo = Math.min(p25, item.line, mean ?? p25);
  const hi = Math.max(p75, item.line, mean ?? p75);
  const span = hi - lo || 1;
  const W = 240;
  const H = 40;
  const x = (v: number) => ((v - lo) / span) * (W - 8) + 4;

  const boxX = x(p25);
  const boxW = Math.max(2, x(p75) - x(p25));
  const lineX = x(item.line);
  const medX = x(median);

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="mt-1" role="img" aria-label="Simulated distribution">
      {/* baseline */}
      <line x1={4} y1={H - 10} x2={W - 4} y2={H - 10} stroke="#1E2C44" strokeWidth={1} />
      {/* p25–p75 box */}
      <rect x={boxX} y={10} width={boxW} height={H - 22} rx={2} fill="#C9A22722" stroke="#9A7B1E" strokeWidth={1} />
      {/* median marker */}
      <line x1={medX} y1={8} x2={medX} y2={H - 8} stroke="#E8C14A" strokeWidth={2} />
      {/* mean marker (dashed) */}
      {mean != null && (
        <line x1={x(mean)} y1={10} x2={x(mean)} y2={H - 10} stroke="#DCE8F0" strokeWidth={1} strokeDasharray="2 2" />
      )}
      {/* posted prop line */}
      <line x1={lineX} y1={2} x2={lineX} y2={H - 6} stroke="#5BC8FF" strokeWidth={1.5} />
      <text x={Math.min(W - 24, Math.max(4, lineX - 8))} y={H - 0.5} fill="#5BC8FF" fontSize={8} fontFamily="monospace">
        {item.line}
      </text>
    </svg>
  );
}

export function PropCard({ item }: { item: PropBoardItem }) {
  const tier = item.tier as Verdict;
  const hex = TIER_HEX[item.tier] ?? "#6B7A99";
  const hr = parseHitRates(item.hit_rates_json);
  const hundredClub = item.hundred_club === 1 || hr?.hundredClub === true;
  const marketLabel = item.market_label ?? item.market_type.replace(/_/g, " ").toUpperCase();
  const sideLabel = item.side === "over" ? "O" : "U";
  const price = item.best_price ?? item.posted_odds;
  const overPct = item.model_prob != null
    ? `${Math.round((item.side === "over" ? item.model_prob : 1 - item.model_prob) * 100)}% ${item.side === "over" ? "Over" : "Under"}`
    : null;

  const liveState = item.liveState ?? "pending";
  const skin = liveSkin(liveState);
  const paidUnits = item.stake_units != null && price != null
    ? (price > 0 ? (price / 100) * item.stake_units : (100 / Math.abs(price)) * item.stake_units)
    : null;
  const paidDollars = paidUnits != null ? Math.round(paidUnits * PROP_UNIT_DOLLARS * 100) / 100 : null;

  return (
    <article
      className="flex flex-col overflow-hidden rounded-xl border border-card-border bg-navy-deep hover-elevate"
      style={{
        borderColor: skin ? skin.border : `${hex}40`,
        boxShadow: skin ? skin.glow : undefined,
      }}
      data-testid={`prop-card-${item.pick_id}`}
      data-live-state={liveState}
    >
      {/* Brand header: scope mark + tier wordmark + tier pill */}
      <div className="flex items-center justify-between gap-2 border-b border-gold/10 bg-gold/[0.04] px-3.5 py-2.5">
        <div className="flex items-center gap-2">
          <span className="overflow-hidden rounded-full">
            <ScopeFull uid={`pc-${item.pick_id}`} size={24} />
          </span>
          <span className="font-display text-[11px] font-extrabold uppercase tracking-[0.22em] text-gold">
            {TIER_WORDMARK[item.tier] ?? "EE RECON"}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {liveState === "paid" && (
            <span
              className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-[0.12em]"
              style={{ color: "#020810", backgroundColor: "#E8C14A", border: "1px solid #C9A227" }}
              data-testid="prop-live-paid"
            >
              PAID{paidUnits != null ? ` +${paidUnits.toFixed(2)}u` : ""}
            </span>
          )}
          {liveState === "busted" && (
            <span
              className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-[0.12em]"
              style={{ color: LIVE_RED, backgroundColor: `${LIVE_RED}1a`, border: `1px solid ${LIVE_RED}55` }}
              data-testid="prop-live-busted"
            >
              BUST
            </span>
          )}
          {liveState === "live_clear" && (
            <span
              className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-[0.12em]"
              style={{ color: LIVE_GREEN, backgroundColor: `${LIVE_GREEN}1a`, border: `1px solid ${LIVE_GREEN}55` }}
              data-testid="prop-live-clear"
            >
              LIVE
            </span>
          )}
          <span
            className="inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-[0.12em]"
            style={{ color: hex, backgroundColor: `${hex}1a`, border: `1px solid ${hex}40` }}
            data-testid={`prop-tier-${tier}`}
          >
            {item.tier}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-2 p-4">
        {/* Player + matchup */}
        <div className="flex items-center gap-2">
          <span className="font-display text-base font-bold uppercase tracking-[0.04em] text-foreground">
            {item.player_name}
          </span>
          {hundredClub && (
            <span
              className="rounded px-1.5 py-0.5 font-display text-[10px] font-bold uppercase tracking-wider"
              style={{ color: "#020810", backgroundColor: "#C9A227" }}
              data-testid="hundred-club-badge"
            >
              100% Club
            </span>
          )}
        </div>
        {item.team && (
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
            {item.team}{item.opponent ? ` vs ${item.opponent}` : ""}
          </span>
        )}

        {/* Market line: "HITS · O 0.5 (−115) · DraftKings" */}
        <div className="font-display text-[13px] uppercase tracking-[0.04em] text-[#C0C6D0]">
          {marketLabel} · {sideLabel} {item.line}
          {price != null && <span className="tabular-nums"> ({fmtLine(price)})</span>}
          {item.best_book && <span className="text-muted-foreground"> · {bookLabel(item.best_book)}</span>}
        </div>

        {/* Sim summary: "Median 0.8 · Edge +12.3% · 60% Over" */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          {item.sim_median != null && (
            <span className="text-muted-foreground">
              Median <span className="font-bold tabular-nums text-foreground">{item.sim_median.toFixed(2)}</span>
            </span>
          )}
          {item.edge_pp != null && (
            <span className="font-bold tabular-nums text-tier-bonus">Edge +{item.edge_pp.toFixed(1)}%</span>
          )}
          {overPct && <span className="text-muted-foreground">{overPct}</span>}
        </div>

        {/* Distribution sketch with a vertical line at the prop line */}
        <DistSketch item={item} />

        {/* Hit-rate row */}
        {hr && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-gold/10 pt-2 text-[11px] text-muted-foreground" data-testid="prop-hit-rates">
            <span>L5 <span className="font-semibold tabular-nums text-foreground/90">{pct(hr.l5.rate)}</span></span>
            <span>L10 <span className="font-semibold tabular-nums text-foreground/90">{pct(hr.l10.rate)}</span></span>
            <span>L20 <span className="font-semibold tabular-nums text-foreground/90">{pct(hr.l20.rate)}</span></span>
            <span>Season <span className="font-semibold tabular-nums text-foreground/90">{pct(hr.season.rate)}</span></span>
          </div>
        )}

        {/* Footer: confidence + data quality + stake */}
        <div className="flex items-center justify-between border-t border-gold/10 pt-2 text-[11px] text-muted-foreground">
          <span>
            {item.confidence != null && <>CONF {item.confidence}</>}
            {item.data_quality_tier && <span className="ml-2 uppercase">· {item.data_quality_tier}</span>}
          </span>
          {item.stake_units != null && (
            <span className="font-display font-bold uppercase tracking-wider text-gold">{item.stake_units}u</span>
          )}
        </div>

        {/* Live caption: current in-game value while tracking, or the PAID OUT
            dollar line once the prop has won and graded ($375/unit). */}
        {liveState !== "pending" && (
          <div className="flex items-center justify-between border-t border-gold/10 pt-2 text-[11px]" data-testid="prop-live-footer">
            {item.currentValue != null ? (
              <span className="uppercase tracking-wider text-muted-foreground">
                Live <span className="font-bold tabular-nums text-foreground">{item.currentValue}</span> / {item.line}
              </span>
            ) : (
              <span />
            )}
            {liveState === "paid" && paidDollars != null && (
              <span className="font-display font-bold uppercase tracking-wider" style={{ color: "#E8C14A" }}>
                PAID OUT +${paidDollars.toLocaleString()}
              </span>
            )}
            {liveState === "busted" && (
              <span className="font-display font-bold uppercase tracking-wider" style={{ color: LIVE_RED }}>
                BUSTED
              </span>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
