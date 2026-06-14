// v6.9.4 — DK tap-through fallback sheet.
// When the DK multi-leg composite deep link cannot be built (all selectionIds
// are null), the three multi-leg buttons open this modal instead.  It lists
// every pick as a tappable row so the user can load each event in DK one at a
// time and check them off as they go.
//
// SessionStorage key: `dk-tapthrough-${date}-${scope}` — persists the "done"
// bitmask across the deep-link round-trip so the sheet looks the same when
// the user navigates back.

import { useState, useEffect, useCallback } from "react";
import { X, ExternalLink, CheckCircle2, Circle } from "lucide-react";
import type { DkSlipPayload } from "@/lib/types";

export interface DkTapThroughSheetProps {
  payload: DkSlipPayload;
  open: boolean;
  onClose: () => void;
}

function storageKey(date: string, scope: string): string {
  return `dk-tapthrough-${date}-${scope}`;
}

function loadDoneSet(date: string, scope: string): Set<string> {
  try {
    const raw = sessionStorage.getItem(storageKey(date, scope));
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as string[];
    return new Set(arr);
  } catch {
    return new Set();
  }
}

function saveDoneSet(date: string, scope: string, done: Set<string>): void {
  try {
    sessionStorage.setItem(storageKey(date, scope), JSON.stringify([...done]));
  } catch {
    // sessionStorage unavailable — silently ignore
  }
}

export function DkTapThroughSheet({ payload, open, onClose }: DkTapThroughSheetProps) {
  const [done, setDone] = useState<Set<string>>(() =>
    loadDoneSet(payload.date, payload.scope),
  );

  // Re-hydrate from sessionStorage every time the sheet is opened (covers the
  // case where the user went to DK and came back).
  useEffect(() => {
    if (open) {
      setDone(loadDoneSet(payload.date, payload.scope));
    }
  }, [open, payload.date, payload.scope]);

  const toggleDone = useCallback(
    (eventId: string) => {
      setDone((prev) => {
        const next = new Set(prev);
        if (next.has(eventId)) {
          next.delete(eventId);
        } else {
          next.add(eventId);
        }
        saveDoneSet(payload.date, payload.scope, next);
        return next;
      });
    },
    [payload.date, payload.scope],
  );

  function handleOpenInDk(deepLink: string) {
    window.location.href = deepLink;
  }

  function handleClose() {
    // Clear sessionStorage when the user explicitly closes the sheet.
    try {
      sessionStorage.removeItem(storageKey(payload.date, payload.scope));
    } catch {
      // ignore
    }
    setDone(new Set());
    onClose();
  }

  if (!open) return null;

  const links = payload.perEventLinks;
  const total = links.length;
  const placedCount = links.filter((l) => done.has(l.eventId)).length;

  return (
    /* Full-screen fixed overlay — matches Navy Black theme */
    <div
      className="fixed inset-0 z-50 flex flex-col"
      style={{ backgroundColor: "#020810" }}
      data-testid="dk-tapthrough-sheet"
      role="dialog"
      aria-modal="true"
      aria-label="Load picks to DraftKings one by one"
    >
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div
        className="flex items-center justify-between border-b px-4 py-3"
        style={{ borderColor: "rgba(255,255,255,0.08)" }}
      >
        <div>
          <p className="font-display text-[13px] font-bold uppercase tracking-[0.14em] text-white">
            Load Picks to DraftKings
          </p>
          <p
            className="mt-0.5 text-[11px] text-muted-foreground"
            data-testid="dk-tapthrough-counter"
          >
            {placedCount} of {total} placed
          </p>
        </div>
        <button
          type="button"
          onClick={handleClose}
          className="rounded-full p-1.5 text-muted-foreground transition-colors hover:text-white"
          aria-label="Close"
          data-testid="dk-tapthrough-close"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* ── Sub-header note ────────────────────────────────────────────── */}
      <div
        className="border-b px-4 py-2"
        style={{ borderColor: "rgba(255,255,255,0.06)" }}
      >
        <p className="text-[11px] text-muted-foreground">
          Tap "Open in DK" to load each pick, then mark it done. Come back here to continue — your progress is saved.
        </p>
      </div>

      {/* ── Pick rows ──────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
        {links.map((link) => {
          const isDone = done.has(link.eventId);
          return (
            <div
              key={link.eventId}
              className="flex items-center gap-3 rounded-xl border px-3 py-3 transition-colors"
              style={{
                borderColor: isDone
                  ? "rgba(83,211,55,0.35)"
                  : "rgba(255,255,255,0.08)",
                backgroundColor: isDone
                  ? "rgba(83,211,55,0.06)"
                  : "rgba(255,255,255,0.03)",
              }}
              data-testid={`dk-tapthrough-row-${link.eventId}`}
            >
              {/* Done toggle */}
              <button
                type="button"
                onClick={() => toggleDone(link.eventId)}
                className="shrink-0 transition-colors"
                aria-label={isDone ? "Mark as not placed" : "Mark as placed"}
                data-testid={`dk-tapthrough-done-${link.eventId}`}
              >
                {isDone ? (
                  <CheckCircle2 className="h-5 w-5" style={{ color: "#53D337" }} />
                ) : (
                  <Circle className="h-5 w-5 text-muted-foreground" />
                )}
              </button>

              {/* Label */}
              <p
                className="flex-1 text-[12px] font-medium leading-snug"
                style={{ color: isDone ? "rgba(255,255,255,0.45)" : "#f1f5f9" }}
              >
                {link.label}
              </p>

              {/* Open in DK button */}
              <button
                type="button"
                onClick={() => handleOpenInDk(link.deepLink)}
                className="flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-display text-[11px] font-bold uppercase tracking-[0.12em] text-black transition-opacity active:opacity-80"
                style={{ backgroundColor: "#53D337" }}
                aria-label={`Open ${link.label} in DraftKings`}
                data-testid={`dk-tapthrough-open-${link.eventId}`}
              >
                <ExternalLink className="h-3 w-3 shrink-0" />
                Open in DK
              </button>
            </div>
          );
        })}
      </div>

      {/* ── Footer ─────────────────────────────────────────────────────── */}
      <div
        className="border-t px-4 py-4"
        style={{ borderColor: "rgba(255,255,255,0.08)" }}
      >
        <button
          type="button"
          onClick={handleClose}
          className="flex w-full items-center justify-center rounded-xl border px-4 py-3 text-[13px] font-semibold text-muted-foreground transition-colors hover:text-white"
          style={{ borderColor: "rgba(255,255,255,0.12)" }}
          data-testid="dk-tapthrough-close-footer"
        >
          Close
        </button>
      </div>
    </div>
  );
}
