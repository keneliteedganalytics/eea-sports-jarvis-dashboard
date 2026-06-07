import { TIER_META } from "@/lib/format";
import type { Verdict } from "@/lib/types";

export function TierPill({ tier }: { tier: Verdict }) {
  const meta = TIER_META[tier];
  return (
    <span
      data-testid={`tier-pill-${tier}`}
      className="inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-[0.12em]"
      style={{
        color: meta.hex,
        backgroundColor: `${meta.hex}1a`,
        border: `1px solid ${meta.hex}40`,
      }}
    >
      {meta.label}
    </span>
  );
}
