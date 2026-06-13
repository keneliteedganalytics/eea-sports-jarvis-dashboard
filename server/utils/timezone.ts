// Canonical display/operating timezone for the whole server. Defaults to
// US Eastern; override with DISPLAY_TIMEZONE (an IANA zone like "America/Denver")
// to relocate every date label and the operating-day boundary in one place.
export const DISPLAY_TIMEZONE = process.env.DISPLAY_TIMEZONE ?? "America/New_York";
