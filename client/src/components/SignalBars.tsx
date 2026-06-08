// Public / Sharp / PRISM 3-bar. Reframes the Polymarket sentiment signal
// (PRISM) alongside book-consensus signals so no single source is a black box.

function Bar({
  label,
  pct,
  color,
  title,
}: {
  label: string;
  pct: number | null;
  color: string;
  title?: string;
}) {
  const isNull = pct === null;
  const clamped = isNull ? 0 : Math.max(0, Math.min(100, pct));
  return (
    <div
      className="flex items-center gap-2"
      data-testid={`signal-bar-${label.toLowerCase()}`}
      title={title}
    >
      <span className="w-12 text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-white/5">
        <div
          className="h-full rounded-full transition-all"
          style={{
            width: `${clamped}%`,
            backgroundColor: isNull ? "#555" : color,
            opacity: isNull ? 0.3 : 1,
          }}
        />
      </div>
      <span className="w-9 text-right text-[11px] tabular-nums text-foreground">
        {isNull ? "—" : `${clamped.toFixed(0)}%`}
      </span>
    </div>
  );
}

export interface SignalBarsProps {
  publicPct: number | null; // book consensus implied %
  sharpPct: number | null;  // sharp-book implied %
  prismPct: number | null;  // Polymarket %
  prismReason?: string | null; // tooltip when prism unavailable
}

export function SignalBars({ publicPct, sharpPct, prismPct, prismReason }: SignalBarsProps) {
  return (
    <div className="space-y-1.5">
      <Bar label="Public" pct={publicPct} color="#8892A0" />
      <Bar label="Sharp" pct={sharpPct} color="#C9A227" />
      <Bar
        label="PRISM"
        pct={prismPct}
        color="#5BC0EB"
        title={prismPct === null ? (prismReason ?? "No Polymarket market available") : undefined}
      />
    </div>
  );
}
