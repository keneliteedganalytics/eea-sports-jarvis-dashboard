import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import { queryClient } from "@/lib/queryClient";
import type { BuiltPick } from "@/lib/types";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

// Admin PIN gate for lock-in. Read from the build-time env if present, else the
// desk default — mirrors the server's ADMIN_PIN.
const ADMIN_PIN = (import.meta.env.VITE_ADMIN_PIN as string | undefined) || "5811";

// Composite graded-book id: gameId:pickType:pickSide.
function gradedId(pick: BuiltPick): string {
  return `${pick.gameId}:${pick.pickType}:${pick.pickSide}`;
}

// "Bet Placed" confirmation. Freezes the pick's tier/stake/odds server-side; once
// locked the row renders a lock badge and the button disappears. Only shown on
// actionable, not-yet-locked, not-yet-final picks.
export function BetPlacedButton({ pick }: { pick: BuiltPick }) {
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${API_BASE}/api/picks/${encodeURIComponent(gradedId(pick))}/confirm-bet`, {
        method: "POST",
        headers: { "x-admin-pin": ADMIN_PIN },
      });
      if (!res.ok) throw new Error(`${res.status}: ${(await res.text()) || res.statusText}`);
      return res.json();
    },
    onSuccess: () => {
      // Refresh every slate view so the locked tier/stake is reflected everywhere.
      void queryClient.invalidateQueries();
    },
    onError: (e: Error) => setError(e.message),
  });

  if (pick.locked) {
    return (
      <div
        className="flex items-center justify-center gap-1.5 rounded-lg border border-gold/30 bg-gold/[0.06] px-2.5 py-1.5 font-display text-[11px] font-bold uppercase tracking-[0.18em] text-gold"
        data-testid={`locked-${pick.gameId}`}
      >
        <Lock className="h-3 w-3" />
        Locked · {pick.lockedTier ?? pick.verdictTier}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => mutation.mutate()}
        disabled={mutation.isPending}
        className="flex items-center justify-center gap-1.5 rounded-lg border border-gold/40 bg-gold/10 px-2.5 py-1.5 font-display text-[11px] font-bold uppercase tracking-[0.18em] text-gold transition-colors hover:bg-gold/20 disabled:opacity-50"
        data-testid={`bet-placed-${pick.gameId}`}
      >
        <Lock className="h-3 w-3" />
        {mutation.isPending ? "Locking…" : "Bet Placed"}
      </button>
      {error && <span className="text-[10px] text-trap">{error}</span>}
    </div>
  );
}
