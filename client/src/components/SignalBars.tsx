// Public / Sharp / PRISM 3-bar. Reframes the Polymarket sentiment signal
// (PRISM) alongside book-consensus signals so no single source is a black box.

function Bar({ label, pct, color }: { label: string; pct: number; color: string }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div className="flex items-center gap-2" data-testid={`signal-bar-${label.toLowerCase()}`}>
      <span className="w-12 text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-white/5">
        <div className="h-full rounded-full transition-all" style={{ width: `${clamped}%`, backgroundColor: color }} />
      </div>
      <span className="w-9 text-right text-[11px] tabular-nums text-foreground">{clamped.toFixed(0)}%</span>
    </div>
  );
}

export interface SignalBarsProps {
  publicPct: number; // book consensus implied %
  sharpPct: number; // model %
  prismPct: number | null; // Polymarket %
}

export function SignalBars({ publicPct, sharpPct, prismPct }: SignalBarsProps) {
  return (
    <div className="space-y-1.5">
      <Bar label="Public" pct={publicPct} color="#8892A0" />
      <Bar label="Sharp" pct={sharpPct} color="#C9A227" />
      <Bar label="PRISM" pct={prismPct ?? 0} color="#5BC0EB" />
    </div>
  );
}
