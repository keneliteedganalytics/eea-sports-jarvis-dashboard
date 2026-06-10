import type { Express, Request, Response } from "express";
import type { Server } from "node:http";
import fs from "node:fs";
import { initSchema } from "./storage";
import { getSlate } from "./sports/mlb/slate";
import { getNhlSlate } from "./sports/nhl/slate";
import { getNbaSlate } from "./sports/nba/slate";
import { getDailySlate, getAnyPick, decorateSlatePicks, excludeArchivedPicks } from "./slate/orchestrator";
import { getProps } from "./props";
import { buildPropAnalytics } from "./sports/props/analytics";
import { hitRatesByTier, trackRecord } from "./sports/mlb/trackRecord";
import { buildAnalytics } from "./analytics";
import { generateBrief } from "./audio/brief";
import { generateSpeech, getCachedFilePath, hasElevenLabsKey } from "./audio/tts";
import { getAlerts } from "./pollers/alerts";
import { startOddsPoller } from "./pollers/oddsPoller";
import { startScratchPoller } from "./pollers/scratchPoller";
import { startLiveScoring, pollEspnAndUpdate } from "./jobs/liveScoring";
import { startLockWorker } from "./jobs/lockWorker";
import { startPropIngestWorker, getLastIngestSummary } from "./jobs/propIngest";
import { tomorrowOperatingDay } from "./jobs/propIngest";
import { startLivePropTracker } from "./jobs/livePropTracker";
import { reconciliationFlag } from "./jobs/reconcileFalseGrades";
import { getOperatingDay } from "./sports/mlb/operatingDay";
import { hasOddsKey, fetchMlbEvents } from "./sports/props/ingestMlbProps";
import {
  confirmBet,
  adminLockWithOverride,
  getBankrollState,
  gradedDb,
  dbPath,
  pickHistoryCount,
  archivedPicks,
  propBoard,
  getPropPick,
  countPropOffersForDate,
  countPropPicksForDate,
  getPropPickLiveStates,
} from "./gradedBook";
import { BANKROLL_USD } from "./sports/mlb/picksEngine";
import { z } from "zod";

const STUB_SPORTS = ["ncaaf", "ncaab", "nfl"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Admin actions (bet lock-in) are gated behind a PIN supplied via x-admin-pin.
// Override with ADMIN_PIN; defaults to the desk PIN.
const ADMIN_PIN = process.env.ADMIN_PIN || "5811";
function requireAdminPin(req: Request, res: Response): boolean {
  if (req.header("x-admin-pin") === ADMIN_PIN) return true;
  res.status(401).json({ message: "admin pin required" });
  return false;
}

// Stricter gate for the destructive admin-override path: a bad/absent PIN is a
// forbidden action (403) rather than a "please authenticate" (401).
function requireAdminPinForbidden(req: Request, res: Response): boolean {
  if (req.header("x-admin-pin") === ADMIN_PIN) return true;
  res.status(403).json({ message: "admin pin required" });
  return false;
}

const adminLockBody = z.object({
  tier: z.enum(["SNIPER", "EDGE", "DUAL", "RECON", "PASS"]),
  odds: z.number().optional(),
  stake: z.number().optional(),
  reason: z.string().min(1),
  seedFromLive: z.boolean().optional(),
});

function bankroll(): number {
  const n = Number(process.env.BANKROLL_USD);
  return Number.isFinite(n) && n > 0 ? n : BANKROLL_USD;
}

// Validate the ?date= query param. Returns a YYYY-MM-DD string or undefined.
function parseDateParam(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !DATE_RE.test(raw)) return undefined;
  const t = Date.parse(`${raw}T12:00:00Z`);
  return Number.isNaN(t) ? undefined : raw;
}

// Parse a stored JSON blob (sim/hit-rate snapshots) without throwing on a bad row.
function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// Kick off every timer-driven background worker. Each start* fires one run
// immediately (so a fresh container repopulates live scores + CLV without waiting
// for the first interval tick) then settles into its cadence; all are idempotent.
// Called from the HTTP listen callback so the immediate run happens after the
// port is bound and never delays health checks. Each immediate run is internally
// void+catch-guarded, so a worker throwing on boot can't crash the process.
export function startBackgroundWorkers(): void {
  startOddsPoller();
  startScratchPoller();
  startLiveScoring();
  startLockWorker();
  startPropIngestWorker();
  startLivePropTracker();
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  initSchema();

  // Unified cross-sport board (MLB + NHL + NBA). ?date=YYYY-MM-DD overrides the
  // operating day so historical/forward slates can be inspected.
  app.get("/api/slate", async (req: Request, res: Response) => {
    const dateIso = parseDateParam(req.query.date);
    // The live board (no explicit date) is in-flight only — drop graded/archived
    // picks. A past-date query (Yesterday) keeps its graded picks.
    const slate = await getDailySlate(bankroll(), dateIso, { excludeArchived: !dateIso });
    res.json(slate);
  });

  // Today's MLB slate (capped, tiered picks). Picks are decorated with their
  // graded-book status + CLV badge so the cards render grade colors and the
  // "Lock at first pitch" chip — same enrichment the cross-sport board applies.
  app.get("/api/mlb/slate", async (req: Request, res: Response) => {
    const dateIso = parseDateParam(req.query.date);
    const slate = await getSlate(bankroll(), dateIso);
    decorateSlatePicks(slate.picks, slate.operatingDay);
    if (!dateIso) slate.picks = excludeArchivedPicks(slate.picks);
    // Sizing used the configured starting bankroll; the board shows the running
    // bankroll, which adjusts as picks grade W/L.
    res.json({ ...slate, bankroll: getBankrollState().current });
  });

  // NHL + NBA slates.
  app.get("/api/nhl/slate", async (req: Request, res: Response) => {
    const dateIso = parseDateParam(req.query.date);
    const slate = await getNhlSlate(bankroll(), dateIso);
    decorateSlatePicks(slate.picks, slate.operatingDay);
    if (!dateIso) slate.picks = excludeArchivedPicks(slate.picks);
    res.json({ ...slate, bankroll: getBankrollState().current });
  });
  app.get("/api/nba/slate", async (req: Request, res: Response) => {
    const dateIso = parseDateParam(req.query.date);
    const slate = await getNbaSlate(bankroll(), dateIso);
    decorateSlatePicks(slate.picks, slate.operatingDay);
    if (!dateIso) slate.picks = excludeArchivedPicks(slate.picks);
    res.json({ ...slate, bankroll: getBankrollState().current });
  });

  // Single pick detail (any sport).
  app.get("/api/mlb/pick/:id", async (req: Request, res: Response) => {
    const pick = await getAnyPick(String(req.params.id), bankroll());
    if (!pick) return res.status(404).json({ message: "pick not found" });
    res.json(pick);
  });

  // Cross-sport pick detail.
  app.get("/api/pick/:id", async (req: Request, res: Response) => {
    const pick = await getAnyPick(String(req.params.id), bankroll());
    if (!pick) return res.status(404).json({ message: "pick not found" });
    res.json(pick);
  });

  // Hit-rate cache (per-tier 30/60/90).
  app.get("/api/mlb/hit-rates", (_req: Request, res: Response) => {
    res.json(hitRatesByTier("MLB"));
  });

  // Track Record summary + graded bet log. Per-sport and all-sports variants;
  // an empty graded book returns zero KPIs + an empty log (UI shows the empty
  // state). No seed data anywhere — every row is a real, settled pick.
  app.get("/api/track-record", (_req: Request, res: Response) => {
    res.json(trackRecord("ALL"));
  });
  app.get("/api/mlb/track-record", (_req: Request, res: Response) => {
    res.json(trackRecord("MLB"));
  });
  app.get("/api/nhl/track-record", (_req: Request, res: Response) => {
    res.json(trackRecord("NHL"));
  });
  app.get("/api/nba/track-record", (_req: Request, res: Response) => {
    res.json(trackRecord("NBA"));
  });
  app.get("/api/soccer/track-record", (_req: Request, res: Response) => {
    res.json(trackRecord("SOCCER"));
  });

  // Running bankroll + lifetime W/L/P ledger. Reflects real settled P/L, not the
  // static BANKROLL_USD seed.
  app.get("/api/bankroll", (_req: Request, res: Response) => {
    res.json(getBankrollState());
  });

  // Persistence diagnostics (read-only, unauthenticated, low-risk). Curl this
  // after a deploy to confirm the SQLite file resolved onto the mounted volume
  // and the tables/counts look right.
  app.get("/api/debug/persistence", (_req: Request, res: Response) => {
    const file = dbPath();
    let dbExists = false;
    let dbSizeBytes = 0;
    try {
      const stat = fs.statSync(file);
      dbExists = true;
      dbSizeBytes = stat.size;
    } catch {
      dbExists = false;
    }
    const db = gradedDb();
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>
    ).map((t) => t.name);
    const countFor = (status: string): number =>
      (db.prepare("SELECT COUNT(*) AS n FROM picks WHERE status = ?").get(status) as { n: number }).n;
    const bankroll = getBankrollState();
    res.json({
      dbPath: file,
      dbExists,
      dbSizeBytes,
      tables,
      pickCounts: {
        pending: countFor("pending"),
        in_progress: countFor("in_progress"),
        final: countFor("final"),
      },
      historyCount: pickHistoryCount(),
      bankroll: {
        starting: bankroll.starting,
        current: bankroll.current,
        lastUpdated: bankroll.lastUpdated,
      },
      railwayVolumeMountPath: process.env.RAILWAY_VOLUME_MOUNT_PATH || null,
      gradedBookPathEnv: process.env.GRADED_BOOK_PATH || null,
    });
  });

  // v6.7.5: report the one-shot false-grade reconciliation outcome. Detail rows
  // are reconstructed from the pick_audit entries the unwind wrote (reason prefix
  // "false_grade_unwound_v675") joined to the (now-reset) prop_picks row for the
  // player/market/side/line, with originalResult / originalPlDollars / status
  // parsed from the audit reason.
  app.get("/api/debug/reconciliation", (_req: Request, res: Response) => {
    const flag = reconciliationFlag();
    const db = gradedDb();
    // Read-only diagnostic: why is the candidate set empty? Lists every graded
    // prop pick with its offer game_date + event teams so we can see whether the
    // date join or the team resolution is the blocker.
    if (_req.query.diagnose) {
      const graded = db
        .prepare(
          `SELECT p.pick_id, p.game_id, p.player_name, p.market_type, p.side, p.line,
                  p.team, p.opponent, p.result, p.pl_dollars, p.live_status,
                  (SELECT o.game_date FROM prop_offers o WHERE o.event_id = p.game_id
                     AND o.game_date IS NOT NULL LIMIT 1) AS offer_game_date,
                  (SELECT o.event_home FROM prop_offers o WHERE o.event_id = p.game_id
                     AND (o.event_home IS NOT NULL OR o.event_away IS NOT NULL) LIMIT 1) AS event_home,
                  (SELECT o.event_away FROM prop_offers o WHERE o.event_id = p.game_id
                     AND (o.event_home IS NOT NULL OR o.event_away IS NOT NULL) LIMIT 1) AS event_away
             FROM prop_picks p WHERE p.result IS NOT NULL ORDER BY p.player_name ASC`,
        )
        .all();
      return res.json({ operatingDay: getOperatingDay(), gradedCount: (graded as unknown[]).length, graded });
    }
    const rows = db
      .prepare(
        `SELECT a.pickId AS pick_id, a.reason AS reason, a.createdAt AS created_at,
                p.player_name AS player, p.market_type AS market, p.side AS side, p.line AS line
           FROM pick_audit a
           LEFT JOIN prop_picks p ON p.pick_id = a.pickId
          WHERE a.reason LIKE 'false_grade_unwound_v675%'
          ORDER BY a.createdAt ASC`,
      )
      .all() as Array<{
        pick_id: string;
        reason: string;
        created_at: string;
        player: string | null;
        market: string | null;
        side: string | null;
        line: number | null;
      }>;
    const details = rows.map((r) => {
      const resultM = /result=(\w+)/.exec(r.reason);
      const plM = /pl_dollars=(-?[\d.]+)/.exec(r.reason);
      const statusM = /gameStatus=(\w+)/.exec(r.reason);
      return {
        pick_id: r.pick_id,
        player: r.player,
        market: r.market,
        side: r.side,
        line: r.line,
        originalResult: resultM ? resultM[1] : null,
        originalPlDollars: plM ? Number(plM[1]) : null,
        gameStatusAtUnwind: statusM ? statusM[1] : null,
      };
    });
    const bankrollAdjustment = details.reduce((s, d) => s + (d.originalPlDollars ?? 0), 0);
    res.json({
      ran: flag.ran,
      completedAt: flag.completedAt,
      picksUnwound: details.length,
      bankrollAdjustment: Math.round(bankrollAdjustment * 100) / 100,
      details,
    });
  });

  // Admin: run one live-scoring pass for a date (?date=YYYY-MM-DD, default
  // today's operating day). Fetches the public ESPN scoreboard, updates live
  // scores, and grades any games that have gone final.
  app.post("/api/admin/poll-now", async (req: Request, res: Response) => {
    const date = parseDateParam(req.query.date) ?? new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());
    const summary = await pollEspnAndUpdate(date);
    res.json(summary);
  });

  // Confirm a bet was placed: freezes the pick's tier/stake/odds so no downstream
  // recompute can re-tier it. Admin-PIN gated. Idempotent — a second call returns
  // the same frozen row.
  app.post("/api/picks/:id/confirm-bet", (req: Request, res: Response) => {
    if (!requireAdminPin(req, res)) return;
    const frozen = confirmBet(String(req.params.id));
    if (!frozen) return res.status(404).json({ message: "pick not found" });
    res.json(frozen);
  });

  // Admin recovery: override a pick's tier/odds/stake, then snapshot+lock it.
  // For repairing a pick whose stored tier was clobbered by a recompute before
  // the user locked it. Records the change in pick_audit. PIN-gated (403 on
  // failure). Returns the frozen pick + the audit row.
  app.post("/api/picks/:id/admin-lock", async (req: Request, res: Response) => {
    if (!requireAdminPinForbidden(req, res)) return;
    const parsed = adminLockBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "invalid body", issues: parsed.error.issues });
    const result = await adminLockWithOverride(String(req.params.id), parsed.data);
    if (!result) return res.status(404).json({ message: "pick not found" });
    res.json(result);
  });

  // Analytics dashboard aggregation. Optional ?sport= ?tier= ?since= filters.
  app.get("/api/analytics", (req: Request, res: Response) => {
    const sport = typeof req.query.sport === "string" ? req.query.sport : null;
    const tier = typeof req.query.tier === "string" ? req.query.tier : null;
    const since = parseDateParam(req.query.since) ?? null;
    res.json(buildAnalytics({ sport, tier, since }));
  });

  // Player props for a sport+date. Headline markets only; MLB carries a Poisson
  // edge, NHL/NBA are display-only (uncalibrated) for day one.
  app.get("/api/props", async (req: Request, res: Response) => {
    const sport = String(req.query.sport ?? "mlb");
    const date = String(req.query.date ?? "");
    res.json(await getProps(sport, date, bankroll()));
  });

  // Archived (settled + cleared-off-board) picks from the permanent ledger.
  // Paginated, newest-graded first, with sport / result / tier / since filters.
  app.get("/api/archive", (req: Request, res: Response) => {
    const sport = typeof req.query.sport === "string" ? req.query.sport : null;
    const result = typeof req.query.result === "string" ? req.query.result : null;
    const tier = typeof req.query.tier === "string" ? req.query.tier : null;
    const since = parseDateParam(req.query.since) ?? null;
    const limit = Number(req.query.limit ?? 50);
    const offset = Number(req.query.offset ?? 0);
    res.json(archivedPicks({ sport, result, tier, since, limit, offset }));
  });

  // Active (ungraded) player-prop picks for a sport+date — the PROPS board view.
  // Rows carry the simulation summary + hit-rate snapshot + best-book price the
  // pick builder wrote (v6.7). Empty when no props clear the surfacing gate.
  app.get("/api/props/board", (req: Request, res: Response) => {
    const sport = typeof req.query.sport === "string" ? req.query.sport : null;
    const date = parseDateParam(req.query.date) ?? null;
    // Surface the live-tracking fields on the FIRST render (camelCased like the
    // rest of the API) so cards can color without waiting for the /live poll.
    const items = propBoard({ sport, date }).map((row) => ({
      ...row,
      liveState: row.live_state ?? "pending",
      currentValue: row.live_value,
      gameStatus: row.live_status ?? null,
    }));
    res.json({ sport: sport ?? "ALL", date, items });
  });

  // Live in-game prop tracking (v6.7.3). Returns the stored live disposition of
  // every active prop pick on the slate — { pick_id → { liveState, currentValue,
  // gameStatus, lastUpdated } } — so the board can poll (every 15s) and turn a
  // card green (clearing), red (busted), or mark it PAID without a page refresh.
  // The 60s background worker writes these states; this endpoint just reads them.
  // Best-effort: a pick with no stored state reads as "pending".
  app.get("/api/props/live", (req: Request, res: Response) => {
    const sport = typeof req.query.sport === "string" ? req.query.sport : "mlb";
    const date = parseDateParam(req.query.date) ?? getOperatingDay();
    const tracking: Record<
      string,
      { liveState: string; currentValue: number | null; gameStatus: string | null; lastUpdated: string | null }
    > = {};
    try {
      for (const row of getPropPickLiveStates(date, sport)) {
        tracking[row.pick_id] = {
          liveState: row.live_state ?? "pending",
          currentValue: row.live_value,
          gameStatus: row.live_status ?? null,
          lastUpdated: row.live_updated_at,
        };
      }
    } catch {
      // best-effort; an empty tracking map reads as all-pending on the board
    }
    res.json({ date, tracking });
  });

  // Single prop-pick detail: the full row plus the parsed simulation distribution
  // summary, hit-rate windows, and matchup notes for the card detail view.
  app.get("/api/props/board/:pickId", (req: Request, res: Response) => {
    const row = getPropPick(String(req.params.pickId));
    if (!row) return res.status(404).json({ message: "prop pick not found" });
    const hitRates = row.hit_rates_json ? safeParse(row.hit_rates_json) : null;
    const matchup = row.matchup_json ? safeParse(row.matchup_json) : null;
    res.json({
      ...row,
      simulation: {
        median: row.sim_median,
        p25: row.sim_p25,
        p75: row.sim_p75,
        mean: row.sim_mean,
        trials: row.sim_trials,
        modelProb: row.model_prob,
      },
      hitRates,
      matchup,
    });
  });

  // Prop-specific analytics: record, ROI, CLV, and breakdowns by market / player /
  // line distance / data-quality tier. Zeroed shape when no props are graded yet.
  app.get("/api/props/analytics", (req: Request, res: Response) => {
    const sport = typeof req.query.sport === "string" ? req.query.sport : null;
    const since = parseDateParam(req.query.since) ?? null;
    res.json(buildPropAnalytics({ sport, since }));
  });

  // Prop-ingest diagnostic (v6.7.1). Surfaces the two operating days, whether an
  // Odds API key is configured, the stored offer/pick counts per day, the last
  // worker run summary, and a LIVE probe of how many MLB events the Odds API
  // reports for today — so an empty board can be triaged (no key vs. no upstream
  // events vs. ingest not yet run).
  app.get("/api/props/debug", async (_req: Request, res: Response) => {
    const today = getOperatingDay();
    const tomorrow = tomorrowOperatingDay();
    let eventsTodayProbe: number | null = null;
    try {
      eventsTodayProbe = hasOddsKey() ? (await fetchMlbEvents(today)).length : null;
    } catch {
      eventsTodayProbe = null;
    }
    res.json({
      today,
      tomorrow,
      hasOddsKey: hasOddsKey(),
      offersToday: countPropOffersForDate(today, "mlb"),
      offersTomorrow: countPropOffersForDate(tomorrow, "mlb"),
      picksToday: countPropPicksForDate(today, "mlb"),
      picksTomorrow: countPropPicksForDate(tomorrow, "mlb"),
      lastIngestSummary: getLastIngestSummary(),
      eventsTodayProbe,
    });
  });

  // Alerts (steam / scratch). ?since=<id> for incremental polling.
  app.get("/api/alerts", (req: Request, res: Response) => {
    const since = Number(req.query.since ?? 0);
    res.json(getAlerts(Number.isFinite(since) ? since : 0));
  });

  // Generate (or fetch cached) audio brief for a pick. Returns { audioUrl,
  // text, available } — available=false means no ElevenLabs key (UI shows the
  // brief text without playback). The voice is chosen from the resolved pick's
  // sport (soccer → UK, otherwise US), so the route path is purely cosmetic and
  // every sport's pick is looked up cross-sport via getAnyPick.
  const handleBrief = async (req: Request, res: Response) => {
    const pick = await getAnyPick(String(req.params.id), bankroll());
    if (!pick) return res.status(404).json({ message: "pick not found" });
    const text = await generateBrief(pick, bankroll());
    if (!hasElevenLabsKey()) {
      return res.json({ text, audioUrl: null, available: false });
    }
    try {
      const speech = await generateSpeech(text, pick.sport);
      res.json({ text, audioUrl: speech.audioUrl, available: true, cached: speech.cached });
    } catch (e) {
      res.json({ text, audioUrl: null, available: false, error: e instanceof Error ? e.message : "tts failed" });
    }
  };
  app.post("/api/mlb/brief/:id", handleBrief);
  app.post("/api/nhl/brief/:id", handleBrief);
  app.post("/api/nba/brief/:id", handleBrief);
  app.post("/api/soccer/brief/:id", handleBrief);

  // Serve cached MP3 by hash.
  app.get("/api/audio/:hash", (req: Request, res: Response) => {
    const path = getCachedFilePath(String(req.params.hash));
    if (!path || !fs.existsSync(path)) return res.status(404).json({ message: "audio not found" });
    res.setHeader("Content-Type", "audio/mpeg");
    fs.createReadStream(path).pipe(res);
  });

  // Stub sport tabs — same engine, model not yet wired.
  app.get("/api/:sport/slate", (req: Request, res: Response) => {
    const sport = String(req.params.sport);
    if (STUB_SPORTS.includes(sport)) {
      return res.json({
        operatingDay: null,
        isDemo: true,
        comingSoon: true,
        sport: sport.toUpperCase(),
        message: "Coming soon — same engine, sport-specific model.",
        picks: [],
      });
    }
    res.status(404).json({ message: "unknown sport" });
  });

  return httpServer;
}
