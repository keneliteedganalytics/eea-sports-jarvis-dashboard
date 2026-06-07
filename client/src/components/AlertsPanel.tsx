import { useEffect, useRef, useState } from "react";
import { Bell, Flame, UserX, X } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { AlertItem } from "@/lib/types";

const POLL_MS = 30000;

// Polls /api/alerts for steam + scratch events, raises a toast on each new one,
// and keeps a side-panel log. since= is the highest id seen so far.
export function AlertsPanel() {
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [open, setOpen] = useState(false);
  const sinceRef = useRef(0);
  const seededRef = useRef(false);
  const { toast } = useToast();

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await apiRequest("GET", `/api/alerts?since=${sinceRef.current}`);
        const fresh = (await res.json()) as AlertItem[];
        if (cancelled || fresh.length === 0) return;
        sinceRef.current = Math.max(sinceRef.current, ...fresh.map((a) => a.id));
        setAlerts((prev) => [...fresh.reverse(), ...prev].slice(0, 50));
        // Don't toast the initial backfill — only genuinely new events.
        if (seededRef.current) {
          for (const a of fresh) {
            toast({
              title: a.kind === "STEAM" ? "Steam move" : "Scratch",
              description: a.message,
            });
          }
        }
        seededRef.current = true;
      } catch {
        // Network blip — try again next tick.
      }
    }

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [toast]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="relative flex h-9 w-9 items-center justify-center rounded-lg border border-card-border bg-navy-card text-muted-foreground hover:text-gold"
        data-testid="button-alerts-toggle"
        aria-label="Alerts"
      >
        <Bell className="h-4 w-4" />
        {alerts.length > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-gold px-1 text-[10px] font-bold text-navy-bg">
            {alerts.length}
          </span>
        )}
      </button>

      {open && (
        <div
          className="absolute right-4 top-14 z-50 w-80 rounded-xl border border-card-border bg-navy-card p-3 shadow-2xl"
          data-testid="alerts-panel"
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider text-gold">Desk Alerts</span>
            <button type="button" onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          </div>
          {alerts.length === 0 ? (
            <div className="py-6 text-center text-xs text-muted-foreground">No alerts yet — desk is quiet.</div>
          ) : (
            <ul className="max-h-80 space-y-1.5 overflow-y-auto">
              {alerts.map((a) => (
                <li key={a.id} className="flex items-start gap-2 rounded-lg bg-black/20 p-2 text-xs">
                  {a.kind === "STEAM" ? (
                    <Flame className="mt-0.5 h-3.5 w-3.5 shrink-0 text-trap" />
                  ) : (
                    <UserX className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="text-foreground/90">{a.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}
