// v6.14.0 — daily digest. Fires once per operating day at ~6:15 AM ET (just
// after the card locks at 6:00) and emits a plain-text summary: today's locked
// picks + parlays, feed health, yesterday's grade/P&L, and the bankroll
// roll-forward.
//
// Delivery: the project has no push channel wired yet, so this logs the digest
// to stdout and — if DIGEST_WEBHOOK_URL is set — POSTs the text there (Slack /
// Discord-compatible `{ text }` body). The composeDigest() half is pure so it
// unit-tests without any network. Run manually with `npm run digest:daily`.

import { getTodayCard, type DailyCard } from "../core/dailyCard";
import { getBankrollState, type BankrollState } from "../gradedBook";
import { trackRecord } from "../sports/mlb/trackRecord";
import { getOperatingDay, yesterdayOperatingDay } from "../sports/mlb/operatingDay";

export interface DigestInputs {
  cardDate: string;
  card: DailyCard | null;
  bankroll: BankrollState;
  yesterday: string;
  yesterdayNetUnits: number | null; // null when no graded picks yesterday
}

function fmtMoney(n: number): string {
  const sign = n >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function fmtAmerican(n: number | null): string {
  if (n === null) return "n/a";
  return n > 0 ? `+${n}` : String(n);
}

// Pure: render the digest text from gathered inputs. No I/O.
export function composeDigest(d: DigestInputs): string {
  const lines: string[] = [];
  lines.push(`EEA DAILY CARD — ${d.cardDate} (locked 6:00 AM ET)`);
  lines.push("");

  const picks = d.card?.picks ?? [];
  if (picks.length === 0) {
    lines.push(`No qualifying plays today${d.card?.passReason ? ` (${d.card.passReason})` : ""}.`);
  } else {
    lines.push(`PICKS (${picks.length}):`);
    for (const p of picks) {
      lines.push(
        `  • [${p.tier}] ${p.matchup} — ${p.selection} @ ${fmtAmerican(p.priceAmerican)} ` +
          `(${p.units}u, edge ${p.edgePp?.toFixed(1) ?? "?"}pp)`,
      );
    }
  }

  const parlays = d.card?.parlays ?? [];
  if (parlays.length > 0) {
    lines.push("");
    lines.push(`PARLAYS (${parlays.length}):`);
    for (const par of parlays) {
      const legTxt = par.legs.map((l) => `${l.selection} ${fmtAmerican(l.priceAmerican)}`).join(" + ");
      lines.push(
        `  • ${par.legs.length}-leg: ${legTxt} → ${fmtAmerican(par.bookAmerican)} ` +
          `(${par.units}u, edge ${par.parlayEdgePp.toFixed(1)}pp)` +
          (par.correlationNote ? ` [${par.correlationNote}]` : ""),
      );
    }
  }

  lines.push("");
  lines.push("YESTERDAY:");
  lines.push(
    `  ${d.yesterday} P&L: ${
      d.yesterdayNetUnits === null
        ? "no graded picks"
        : `${d.yesterdayNetUnits >= 0 ? "+" : ""}${d.yesterdayNetUnits.toFixed(2)}u`
    }`,
  );

  lines.push("");
  lines.push("BANKROLL:");
  const b = d.bankroll;
  lines.push(
    `  $${b.current.toFixed(2)} (lifetime ${fmtMoney(b.netDollars)}, ` +
      `${b.record.wins}-${b.record.losses}-${b.record.pushes}, ROI ${b.roiPct.toFixed(1)}%)`,
  );

  return lines.join("\n");
}

// Gather live inputs (card, bankroll, yesterday's P&L) for a given moment.
export function gatherDigestInputs(now: Date = new Date()): DigestInputs {
  const cardDate = getOperatingDay(now);
  const yesterday = yesterdayOperatingDay(now);
  const card = getTodayCard(now);
  const bankroll = getBankrollState();

  // Yesterday's net: sum graded bet-log entries dated to the prior operating day.
  // Best-effort — a missing/empty log yields null (rendered as "no graded picks").
  let yesterdayNetUnits: number | null = null;
  try {
    const rows = trackRecord("ALL").betLog.filter((r) => r.date === yesterday);
    if (rows.length > 0) {
      yesterdayNetUnits =
        Math.round(rows.reduce((acc, r) => acc + (r.unitsWon ?? 0), 0) * 100) / 100;
    }
  } catch {
    yesterdayNetUnits = null;
  }

  return { cardDate, card, bankroll, yesterday, yesterdayNetUnits };
}

// Compose + deliver the digest. Logs to stdout and POSTs to DIGEST_WEBHOOK_URL
// when configured. Never throws.
export async function runDailyDigest(now: Date = new Date()): Promise<string> {
  const text = composeDigest(gatherDigestInputs(now));
  console.log(`[daily digest]\n${text}`);
  const url = process.env.DIGEST_WEBHOOK_URL;
  if (url) {
    try {
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
    } catch (err) {
      console.warn(`[daily digest] webhook post failed: ${(err as Error).message}`);
    }
  }
  return text;
}

// Fire once per day, targeting ~6:15 AM ET. We poll every 15 minutes and run
// when we enter a new operating day we haven't digested yet (mirrors the card
// lock cadence — the card is already frozen by the time this fires).
let _lastDigestDay: string | null = null;
export function startDailyDigest(): void {
  const tick = (): void => {
    const day = getOperatingDay(new Date());
    if (day !== _lastDigestDay) {
      _lastDigestDay = day;
      void runDailyDigest();
    }
  };
  tick();
  const timer = setInterval(tick, 15 * 60 * 1000);
  if (typeof timer.unref === "function") timer.unref();
}

// CLI one-shot: `npm run digest:daily`.
const invokedDirectly = /dailyDigest(\.ts|\.js)?$/.test(process.argv[1] ?? "");
if (invokedDirectly) {
  runDailyDigest().then(() => process.exit(0));
}
