// In-memory alert buffer. Pollers push steam/scratch alerts here; the UI polls
// /api/alerts to render toasts + the side panel. Bounded ring buffer.

export type AlertKind = "STEAM" | "SCRATCH";

export interface Alert {
  id: number;
  kind: AlertKind;
  gameId: string;
  message: string;
  ts: string;
}

const MAX_ALERTS = 100;
let seq = 1;
const buffer: Alert[] = [];

export function pushAlert(kind: AlertKind, gameId: string, message: string): Alert {
  const a: Alert = { id: seq++, kind, gameId, message, ts: new Date().toISOString() };
  buffer.unshift(a);
  if (buffer.length > MAX_ALERTS) buffer.length = MAX_ALERTS;
  return a;
}

// Return alerts newer than `sinceId` (0 → all). Most-recent first.
export function getAlerts(sinceId = 0): Alert[] {
  return buffer.filter((a) => a.id > sinceId);
}
