// v6.9.5 — DraftKings one-tap deep-link button.
// Renders only on mobile (≤768 px) when the pick carries a `dk` payload,
// which is set exclusively on SNIPER-tier picks.
//
// All deepLink values are now https://sportsbook.draftkings.com/ universal
// links — iOS routes these to the DK app when installed, web sportsbook
// otherwise. No dk:// custom scheme, no 1.5 s fallback timer needed.

import { ExternalLink } from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";

export interface DkPayload {
  selectionId: string | null;
  eventId: string;
  deepLink: string;
}

interface DraftKingsButtonProps {
  dk: DkPayload | null | undefined;
  // Optional label override. Defaults to "Load on DraftKings".
  label?: string;
}

function handleDkTap(dk: DkPayload): void {
  // deepLink is always a valid https:// universal link — navigate directly.
  // iOS universal link handling routes to the DK app if installed.
  const url = dk.deepLink;
  if (!url) return;
  window.location.href = url;
}

export function DraftKingsButton({ dk, label = "Load on DraftKings" }: DraftKingsButtonProps) {
  const isMobile = useIsMobile();

  // Hide entirely on desktop; only show when the pick has DK data.
  if (!isMobile || !dk) return null;

  return (
    <button
      type="button"
      onClick={() => handleDkTap(dk)}
      className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 font-display text-[12px] font-bold uppercase tracking-[0.14em] text-black transition-opacity active:opacity-80"
      style={{ backgroundColor: "#53D337" }}
      data-testid="dk-button"
      aria-label="Load this pick on DraftKings"
    >
      <ExternalLink className="h-3.5 w-3.5 shrink-0" />
      {label}
    </button>
  );
}
