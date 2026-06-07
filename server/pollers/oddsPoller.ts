// Odds poller — every 60s, fetch current MLB odds, diff each side's consensus
// price against the most recent stored snapshot, persist the new snapshot, and
// flag a STEAM MOVE when a line moves >= 10 cents. No-op when ODDS_API_KEY is
// unset (graceful boot).

import { fetchOdds, hasOddsKey } from "../adapters/oddsApi";
import { consensusSnhl, probToAmerican, type Bookmaker } from "../core/odds";
import { storage } from "../storage";
import { pushAlert } from "./alerts";
import { abbrToName } from "../sports/mlb/teams";

export const POLL_INTERVAL_MS = 60_000;
export const STEAM_THRESHOLD_CENTS = 10;

// "Cents" between two American lines on the same side. Uses absolute magnitude
// difference, the standard book convention for moneyline movement.
function centsMoved(prev: number, next: number): number {
  return Math.abs(Math.abs(next) - Math.abs(prev));
}

let timer: NodeJS.Timeout | null = null;

export async function pollOnce(): Promise<void> {
  if (!hasOddsKey()) return;
  const events = await fetchOdds();

  for (const ev of events) {
    const bms: Bookmaker[] = ev.books.map((b) => ({
      key: b.book,
      title: b.book,
      markets: [
        {
          key: "h2h",
          outcomes: [
            ...(b.homePrice !== null ? [{ name: ev.homeTeamFull, price: b.homePrice }] : []),
            ...(b.awayPrice !== null ? [{ name: ev.awayTeamFull, price: b.awayPrice }] : []),
          ],
        },
      ],
    }));

    const consensus = consensusSnhl(bms, ev.homeTeamFull, ev.awayTeamFull, "shin");
    if (!consensus) continue;

    const sides: { side: "home" | "away"; price: number | null; team: string }[] = [
      { side: "home", price: probToAmerican(consensus.homeFairProb), team: ev.homeTeam },
      { side: "away", price: probToAmerican(consensus.awayFairProb), team: ev.awayTeam },
    ];

    for (const s of sides) {
      if (s.price === null) continue;
      const prevSnaps = storage.snapshotsForGame(ev.eventId).filter((x) => x.side === s.side);
      const prev = prevSnaps[0];
      const isOpener = prevSnaps.length === 0;

      if (prev) {
        const moved = centsMoved(prev.americanPrice, s.price);
        if (moved >= STEAM_THRESHOLD_CENTS) {
          pushAlert(
            "STEAM",
            ev.eventId,
            `STEAM MOVE: ${abbrToName(s.team)} ${prev.americanPrice} → ${s.price} (${moved}c)`,
          );
        }
      }

      storage.insertOddsSnapshot({
        gameId: ev.eventId,
        book: "consensus",
        side: s.side,
        americanPrice: Math.round(s.price),
        isOpener,
      });
    }
  }
}

export function startOddsPoller(): void {
  if (timer) return;
  // Fire once on boot, then on the interval.
  void pollOnce().catch((e) => console.error("oddsPoller:", e));
  timer = setInterval(() => void pollOnce().catch((e) => console.error("oddsPoller:", e)), POLL_INTERVAL_MS);
}

export function stopOddsPoller(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
