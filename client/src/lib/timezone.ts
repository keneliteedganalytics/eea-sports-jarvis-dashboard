// Canonical display timezone for the client. Mirrors the server's
// DISPLAY_TIMEZONE. Defaults to US Eastern; override at build time with
// VITE_DISPLAY_TIMEZONE (Vite only exposes env vars prefixed with VITE_).
export const DISPLAY_TIMEZONE =
  (import.meta as { env?: { VITE_DISPLAY_TIMEZONE?: string } }).env?.VITE_DISPLAY_TIMEZONE ??
  "America/New_York";
