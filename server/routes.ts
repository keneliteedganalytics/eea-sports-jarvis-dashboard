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
import { probeSimulator } from "./sports/props/calibrationProbe";
import { isBatterMarket, isPitcherMarket, type PropMarket } from "./sports/props/simulate";
import { hitRatesByTier, trackRecord } from "./sports/mlb/trackRecord";
import { buildAnalytics } from "./analytics";
import { generateBrief } from "./audio/brief";
import { generateSpeech, getCachedFilePath, hasElevenLabsKey } from "./audio/tts";
import { getAlerts } from "./pollers/alerts";
import { startOddsPoller } from "./pollers/oddsPoller";
import { startScratchPoller } from "./pollers/scratchPoller";
import { startLiveScoring, pollEspnAndUpdate } from "./jobs/liveScoring";
import { buildF5Slate, getF5PicksForDay } from "./sports/mlb/f5Slate";
import { startLockWorker } from "./jobs/lockWorker";
import { startPropIngestWorker, getLastIngestSummary } from "./jobs/propIngest";
import { startLivePropTracker } from "./jobs/livePropTracker";
import { reconciliationFlag } from "./jobs/reconcileFalseGrades";
import { recomputeFlag } from "./jobs/recomputeProps";
import { backfillChalkCapV681, chalkCapBackfillFlag, BACKFILL_FLAG } from "./jobs/backfillChalkCap";
import { isChalkierThanSniperCap, SNIPER_MAX_CHALK_AMERICAN } from "./core/tier";
import { getOperatingDay, tomorrowOperatingDay, yesterdayOperatingDay } from "./sports/mlb/operatingDay";
import { DISPLAY_TIMEZONE } from "./utils/timezone";
import { hasOddsKey, fetchMlbEvents } from "./sports/props/ingestMlbProps";
import {
  confirmBet,
  adminLockWithOverride,
  getBankrollState,
  gradedDb,
  dbPath,
  pickHistoryCount,
  archivedPicks,
  unifiedArchive,
  passPicks,
  passSummary,
  propBoard,
  getPropPick,
  countPropOffersForDate,
  countPropPicksForDate,
  getPropPickLiveStates,
  getVirtualParlaysForDate,
  getVirtualParlayStats,
  setSystemState,
  resetEngineBankroll,
  type VirtualParlayRow,
} from "./gradedBook";
import { BANKROLL_USD } from "./sports/mlb/picksEngine";
import { registerPillarDebugRoutes } from "./sources/pillarsDebug";
import { fetchPredictionMarketForGame } from "./adapters/predictionMarkets";
import type { PolySport } from "./adapters/polymarket";
import { assemblePropSignals } from "./sports/signals/assembleSignals";
import type { PropPickRow } from "./gradedBook";
import { z } from "zod";
import { pickToDkLink } from "./lib/dkLinks";

// v6.9.5 — build the DraftKings deep-link payload for a SNIPER prop pick.
// Uses https://sportsbook.draftkings.com/ universal links that iOS routes to
// the DK app (or web sportsbook) without invalid-address errors.
// Returns null for non-SNIPER tiers.
function buildPropDk(
  row: PropPickRow,
): { selectionId: string | null; eventId: string; deepLink: string } | null {
  if (row.tier !== "SNIPER") return null;
  // game_id doubles as the odds-api event ID for props in the current schema.
  const eventId = row.game_id;
  const sport = (row.sport ?? "mlb") as "mlb" | "nhl" | "nba" | "soccer";
  const deepLink = pickToDkLink({ sport, marketType: row.market_type });
  return { selectionId: null, eventId, deepLink };
}

// v6.9.1 — build a prop pick's five-source PickSignals from its stored fields,
// so the props board and parlay legs render the same SignalsBar as game lines.
function propSignalsFor(row: PropPickRow) {
  const side = row.side === "over" || row.side === "under" ? row.side : null;
  return assemblePropSignals({
    side,
    modelProb: row.model_prob,
    edgePp: row.edge_pp,
    postedOdds: row.posted_odds,
    bestPrice: row.best_price,
    closingOdds: row.closing_odds,
  });
}

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

  // v6.10: F5 slate — build (or fetch cached) F5 picks for today / a given date.
  // GET /api/slate/f5?sport=mlb
  // GET /api/slate/f5?sport=mlb&date=YYYY-MM-DD
  app.get("/api/slate/f5", async (req: Request, res: Response) => {
    const sport = String(req.query.sport ?? "mlb").toLowerCase();
    if (sport !== "mlb") {
      res.status(400).json({ error: "Only MLB F5 picks are supported" });
      return;
    }
    const dateIso = parseDateParam(req.query.date);
    try {
      if (dateIso) {
        // Historical date: return persisted picks (no rebuild)
        const picks = getF5PicksForDay(dateIso);
        res.json({ date: dateIso, picks, count: picks.length });
      } else {
        // Today: rebuild and persist
        const result = await buildF5Slate();
        res.json({
          date: result.operatingDay,
          picks: result.picks,
          count: result.picks.length,
          built: result.built,
          ...(result.emptyReason ? { emptyReason: result.emptyReason } : {}),
        });
      }
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // v6.10: Graded F5 picks for a date.
  // GET /api/picks/f5?date=YYYY-MM-DD
  app.get("/api/picks/f5", (req: Request, res: Response) => {
    const dateIso = parseDateParam(req.query.date);
    const { getOperatingDay } = require("./sports/mlb/operatingDay");
    const date = dateIso ?? getOperatingDay(new Date());
    const picks = getF5PicksForDay(date);
    res.json({ date, picks, count: picks.length });
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

  // Date diagnostics (read-only). Curl this to confirm the canonical operating
  // day matches the intended civil date in DISPLAY_TIMEZONE — the source of the
  // "off by a day" class of bugs.
  app.get("/api/debug/dates", (_req: Request, res: Response) => {
    res.json({
      serverUtc: new Date().toISOString(),
      displayTimezone: DISPLAY_TIMEZONE,
      operatingDay: getOperatingDay(),
      tomorrowOperatingDay: tomorrowOperatingDay(),
      yesterdayOperatingDay: yesterdayOperatingDay(),
    });
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
    const scalar = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
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
      // v6.7.7: persistence audit — actionable vs PASS rows in each ledger, so a
      // deploy can confirm PASS picks are being recorded (and not leaking units).
      persistence: {
        gamePicks: {
          total: scalar("SELECT COUNT(*) AS n FROM picks"),
          pass: scalar("SELECT COUNT(*) AS n FROM picks WHERE tier='PASS'"),
          passWithUnits: scalar("SELECT COUNT(*) AS n FROM picks WHERE tier='PASS' AND units > 0"),
        },
        propPicks: {
          total: scalar("SELECT COUNT(*) AS n FROM prop_picks"),
          pass: scalar("SELECT COUNT(*) AS n FROM prop_picks WHERE tier='PASS'"),
          passWithUnits: scalar("SELECT COUNT(*) AS n FROM prop_picks WHERE tier='PASS' AND stake_units > 0"),
        },
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
    // A pick can be unwound on more than one tick (e.g. if a re-grade slipped in
    // between ticks before the tracker fix), so dedupe to the FIRST unwind per
    // distinct pick_id — that carries the original phantom credit. This keeps
    // picksUnwound + bankrollAdjustment equal to the real corruption, not the
    // count of audit rows.
    const seen = new Set<string>();
    const details = rows
      .filter((r) => {
        if (seen.has(r.pick_id)) return false;
        seen.add(r.pick_id);
        return true;
      })
      .map((r) => {
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

  // Diagnostic for the v6.7.6 stale-edge recompute. Reports whether the one-shot
  // re-tier ran (system_state flag) and a live snapshot of today's prop picks by
  // tier so we can confirm the SNIPER count + edge distribution settled into the
  // expected post-fix range without re-running anything.
  app.get("/api/debug/recompute", (_req: Request, res: Response) => {
    const flag = recomputeFlag();
    const db = gradedDb();
    const rows = db
      .prepare(
        `SELECT p.tier AS tier, p.edge_pp AS edge_pp
           FROM prop_picks p
           LEFT JOIN prop_offers o ON o.event_id = p.game_id
          WHERE p.result IS NULL AND o.game_date >= ?
          GROUP BY p.pick_id`,
      )
      .all(getOperatingDay()) as Array<{ tier: string | null; edge_pp: number | null }>;
    const byTier: Record<string, number> = {};
    const sniperEdges: number[] = [];
    for (const r of rows) {
      const tier = r.tier ?? "UNKNOWN";
      byTier[tier] = (byTier[tier] ?? 0) + 1;
      if (tier === "SNIPER" && typeof r.edge_pp === "number") sniperEdges.push(r.edge_pp);
    }
    sniperEdges.sort((a, b) => a - b);
    const median = sniperEdges.length
      ? sniperEdges[Math.floor((sniperEdges.length - 1) / 2)]
      : null;
    res.json({
      ran: flag.ran,
      completedAt: flag.completedAt,
      operatingDay: getOperatingDay(),
      undecided: rows.length,
      byTier,
      sniperEdgePp: {
        count: sniperEdges.length,
        min: sniperEdges[0] ?? null,
        median,
        max: sniperEdges[sniperEdges.length - 1] ?? null,
      },
    });
  });

  // Diagnostic + manual trigger for the v6.8.1 SNIPER chalk-cap backfill. GET
  // reports whether the one-shot ran plus a live count of any undecided SNIPER
  // picks still chalkier than the cap (should be 0 once it has run). POST with a
  // valid admin PIN resets the flag and re-runs it in-process — used to apply the
  // demotion on a deploy without waiting for the next boot. Idempotent either way.
  app.get("/api/debug/chalk-backfill", (_req: Request, res: Response) => {
    const flag = chalkCapBackfillFlag();
    const db = gradedDb();
    const props = db
      .prepare("SELECT posted_odds, best_price FROM prop_picks WHERE result IS NULL AND tier = 'SNIPER'")
      .all() as Array<{ posted_odds: number | null; best_price: number | null }>;
    const games = db
      .prepare("SELECT pickMl FROM picks WHERE status != 'final' AND locked = 0 AND tier = 'SNIPER'")
      .all() as Array<{ pickMl: number | null }>;
    const chalkProps = props.filter((p) => isChalkierThanSniperCap(p.posted_odds ?? p.best_price ?? null)).length;
    const chalkGames = games.filter((g) => isChalkierThanSniperCap(g.pickMl)).length;
    res.json({
      ran: flag.ran,
      completedAt: flag.completedAt,
      cap: SNIPER_MAX_CHALK_AMERICAN,
      undecidedSniper: { props: props.length, games: games.length },
      stillChalkierThanCap: { props: chalkProps, games: chalkGames },
    });
  });

  app.post("/api/debug/chalk-backfill", (req: Request, res: Response) => {
    if (!requireAdminPin(req, res)) return;
    setSystemState(BACKFILL_FLAG, "false"); // clear the guard so the one-shot re-runs
    const summary = backfillChalkCapV681();
    res.json(summary);
  });

  // v6.10.1 MLB slate diagnostics — hit this when the slate returns empty picks
  // to identify exactly which stage of the pipeline is dropping all games.
  app.get("/api/debug/slate-mlb", async (_req: Request, res: Response) => {
    try {
      const { fetchOdds } = await import("./adapters/oddsApi");
      const { fetchSchedule } = await import("./adapters/mlbStats");
      const { getOperatingDay, inOperatingWindow } = await import("./sports/mlb/operatingDay");

      const now = new Date();
      const opDay = getOperatingDay(now);
      const [oddsEvents, schedule] = await Promise.all([fetchOdds(), fetchSchedule(opDay)]);

      const inWindow = oddsEvents.filter((ev: any) => inOperatingWindow(ev.startIso, opDay));
      const outOfWindow = oddsEvents.filter((ev: any) => !inOperatingWindow(ev.startIso, opDay));

      const matchedSchedule = inWindow.map((ev: any) => {
        const sched = schedule.find(
          (s: any) =>
            (s.homeTeam === ev.homeTeam && s.awayTeam === ev.awayTeam) ||
            (s.homeTeamFull === ev.homeTeamFull && s.awayTeamFull === ev.awayTeamFull),
        );
        return {
          eventId: ev.eventId,
          teams: `${ev.awayTeam} @ ${ev.homeTeam}`,
          startIso: ev.startIso,
          hasSched: !!sched,
          homePitcherId: sched?.homePitcherId ?? null,
          awayPitcherId: sched?.awayPitcherId ?? null,
          droppedReason: !sched
            ? "no_schedule_match"
            : sched.homePitcherId === null || sched.awayPitcherId === null
              ? "tbd_pitcher"
              : null,
        };
      });

      res.json({
        now: now.toISOString(),
        opDay,
        oddsApiTotalEvents: oddsEvents.length,
        scheduleTotalGames: schedule.length,
        inWindow: inWindow.length,
        outOfWindow: outOfWindow.length,
        outOfWindowSample: outOfWindow
          .slice(0, 3)
          .map((e: any) => ({ teams: `${e.awayTeam} @ ${e.homeTeam}`, startIso: e.startIso })),
        matchedSchedule,
      });
    } catch (e: any) {
      res.status(500).json({ error: String(e.message || e), stack: e.stack });
    }
  });

  // v6.9.0 Foxtail pillars — read-only debug surface. Each pillar can be probed
  // live (recent form, injuries, run distribution, pitch mix, bullpen load) and a
  // /api/picks/debug?gameId= consolidates the contributions for one game.
  registerPillarDebugRoutes(app);

  // v6.9.0: prediction-market read for a single matchup. Polymarket primary,
  // Kalshi fallback. Read-only, best-effort — a miss returns found:false with a
  // reason, never an error, so the SignalsBar can render an honest label.
  //   GET /api/markets/predict?home=&away=&date=YYYY-MM-DD&side=home|away&sport=mlb
  app.get("/api/markets/predict", async (req: Request, res: Response) => {
    const home = typeof req.query.home === "string" ? req.query.home : "";
    const away = typeof req.query.away === "string" ? req.query.away : "";
    const date = parseDateParam(req.query.date) ?? getOperatingDay();
    const side = req.query.side === "away" ? "away" : "home";
    const sport = (typeof req.query.sport === "string" ? req.query.sport : "mlb") as PolySport;
    if (!home || !away) {
      return res.status(400).json({ message: "home and away team names are required" });
    }
    const result = await fetchPredictionMarketForGame(home, away, date, side, sport);
    res.json({ home, away, date, side, sport, ...result });
  });

  // v6.9.0: DELIBERATE engine bankroll/stats reset. Admin-PIN (403) gated and
  // idempotent per resetKey — this is the ONLY way the running bankroll changes
  // outside a graded pick, and it NEVER fires on boot. Re-buckets prior history to
  // a legacy version tag, resets the bankroll to the target (default starting),
  // and records the event in engine_resets.
  app.post("/api/admin/engine-reset", (req: Request, res: Response) => {
    if (!requireAdminPinForbidden(req, res)) return;
    const body = z
      .object({
        resetKey: z.string().min(1).default("engine_reset_v6_9_0"),
        toEngineVersion: z.string().min(1).default("v6.9.0"),
        legacyBucket: z.string().min(1).optional(),
        newBankroll: z.number().positive().optional(),
      })
      .safeParse(req.body ?? {});
    if (!body.success) {
      return res.status(400).json({ message: "invalid body", issues: body.error.issues });
    }
    const result = resetEngineBankroll(body.data);
    res.json(result);
  });

  // Admin: run one live-scoring pass for a date (?date=YYYY-MM-DD, default
  // today's operating day). Fetches the public ESPN scoreboard, updates live
  // scores, and grades any games that have gone final.
  app.post("/api/admin/poll-now", async (req: Request, res: Response) => {
    const date = parseDateParam(req.query.date) ?? getOperatingDay();
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
    const engineVersion =
      typeof req.query.engineVersion === "string" ? req.query.engineVersion : null;
    res.json(buildAnalytics({ sport, tier, since, engineVersion }));
  });

  // Player props for a sport+date. Headline markets only; MLB carries a Poisson
  // edge, NHL/NBA are display-only (uncalibrated) for day one.
  app.get("/api/props", async (req: Request, res: Response) => {
    const sport = String(req.query.sport ?? "mlb");
    const date = String(req.query.date ?? "");
    res.json(await getProps(sport, date, bankroll()));
  });

  // Archived picks. v6.7.7: the unified archive spans game-line AND player-prop
  // ledgers. When ?type= or ?date= is present, or an explicit ?tier= (incl PASS),
  // it routes through unifiedArchive (combined item shape). When only the legacy
  // sport/result/since/limit/offset params are passed it preserves the old
  // game-line-only response for back-compat.
  app.get("/api/archive", (req: Request, res: Response) => {
    const sport = typeof req.query.sport === "string" ? req.query.sport : null;
    const result = typeof req.query.result === "string" ? req.query.result : null;
    const tier = typeof req.query.tier === "string" ? req.query.tier : null;
    const type = typeof req.query.type === "string" ? req.query.type : null;
    const date = parseDateParam(req.query.date) ?? null;
    const since = parseDateParam(req.query.since) ?? null;
    const limit = Number(req.query.limit ?? 50);
    const offset = Number(req.query.offset ?? 0);
    if (type || date || tier) {
      res.json(unifiedArchive({ type, sport, result, tier, date, since, limit, offset }));
      return;
    }
    res.json(archivedPicks({ sport, result, tier, since, limit, offset }));
  });

  // v6.7.7: the passed-on pile — every evaluated pick (game OR prop) the desk did
  // NOT play (tier='PASS'), across both ledgers, newest-first. ?reason= filters by
  // pass_reason (outlier | model_outlier_v676 | below_threshold | low_data_quality
  // | daily_cap | low_win_prob | other). PASS rows are informational only.
  app.get("/api/passes", (req: Request, res: Response) => {
    const sport = typeof req.query.sport === "string" ? req.query.sport : null;
    const type = typeof req.query.type === "string" ? req.query.type : null;
    const date = parseDateParam(req.query.date) ?? null;
    const since = parseDateParam(req.query.since) ?? null;
    const reason = typeof req.query.reason === "string" ? req.query.reason : null;
    const limit = Number(req.query.limit ?? 100);
    const offset = Number(req.query.offset ?? 0);
    res.json(passPicks({ type, sport, date, since, reason, limit, offset }));
  });

  // Active (ungraded) player-prop picks for a sport+date — the PROPS board view.
  // Rows carry the simulation summary + hit-rate snapshot + best-book price the
  // pick builder wrote (v6.7). Empty when no props clear the surfacing gate.
  app.get("/api/props/board", (req: Request, res: Response) => {
    const sport = typeof req.query.sport === "string" ? req.query.sport : null;
    const date = parseDateParam(req.query.date) ?? null;
    const tier = typeof req.query.tier === "string" ? req.query.tier : null;
    // Surface the live-tracking fields on the FIRST render (camelCased like the
    // rest of the API) so cards can color without waiting for the /live poll.
    const items = propBoard({ sport, date, tier }).map((row) => ({
      ...row,
      liveState: row.live_state ?? "pending",
      currentValue: row.live_value,
      gameStatus: row.live_status ?? null,
      signals: propSignalsFor(row),
      dk: buildPropDk(row),
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
      signals: propSignalsFor(row),
      hitRates,
      matchup,
    });
  });

  // Prop-specific analytics: record, ROI, CLV, and breakdowns by market / player /
  // line distance / data-quality tier. Zeroed shape when no props are graded yet.
  app.get("/api/props/analytics", (req: Request, res: Response) => {
    const sport = typeof req.query.sport === "string" ? req.query.sport : null;
    const since = parseDateParam(req.query.since) ?? null;
    const engineVersion =
      typeof req.query.engineVersion === "string" ? req.query.engineVersion : null;
    res.json(buildPropAnalytics({ sport, since, engineVersion }));
  });

  // v6.7.9: virtual parlay board. Each game group with >=1 SNIPER prop auto-forms
  // a $100 paper parlay that tracks as legs settle (NEVER moves the bankroll).
  // Returns a summary strip + the day's parlays ordered live→pending→settled, each
  // with its legs resolved (player/market/line/side/odds + live disposition).
  app.get("/api/parlays/board", (req: Request, res: Response) => {
    const date = parseDateParam(req.query.date) ?? getOperatingDay();
    const sport = typeof req.query.sport === "string" ? req.query.sport : null;
    const rows = getVirtualParlaysForDate(date, sport);

    const legDisposition = (result: string | null, liveState: string | null): string => {
      if (result === "W") return "won";
      if (result === "L") return "busted";
      if (liveState === "busted") return "busted";
      if (liveState === "live_clear" || liveState === "live") return "live";
      return "pending";
    };

    const items = rows.map((p: VirtualParlayRow) => {
      let pickIds: string[] = [];
      try {
        pickIds = JSON.parse(p.leg_pick_ids ?? "[]") as string[];
      } catch {
        pickIds = [];
      }
      const legs = pickIds
        .map((id) => getPropPick(id))
        .filter((row): row is NonNullable<typeof row> => row != null)
        .map((row) => ({
          pickId: row.pick_id,
          player: row.player_name,
          market: row.market_label ?? row.market_type,
          line: row.line,
          side: row.side,
          odds: row.posted_odds ?? row.best_price ?? null,
          tier: row.tier,
          result: row.result,
          liveState: row.live_state ?? "pending",
          currentValue: row.live_value,
          disposition: legDisposition(row.result, row.live_state),
          signals: propSignalsFor(row),
          dk: buildPropDk(row),
        }));
      return {
        parlayId: p.parlay_id,
        gameId: p.game_id,
        gameLabel: p.game_label,
        // v6.9.1: virtual parlays are one single per SNIPER pick, so mirror the
        // (only) leg's signals to the parlay level for the SignalsBar on the card.
        signals: legs[0]?.signals ?? null,
        sport: p.sport,
        stakeDollars: p.stake_dollars,
        legCount: p.leg_count,
        combinedDecimal: p.combined_decimal,
        combinedAmerican: p.combined_american,
        potentialPayoutDollars: p.potential_payout_dollars,
        potentialProfitDollars: p.potential_profit_dollars,
        status: p.status,
        legsWon: p.legs_won,
        legsBusted: p.legs_busted,
        legsPending: p.legs_pending,
        plDollars: p.pl_dollars,
        gradedAt: p.graded_at,
        legs,
      };
    });

    const summary = {
      date,
      count: items.length,
      live: items.filter((i) => i.status === "live").length,
      pending: items.filter((i) => i.status === "pending").length,
      won: items.filter((i) => i.status === "won").length,
      busted: items.filter((i) => i.status === "busted").length,
      // Realized P/L across SETTLED parlays on this day (paper only).
      plDollars:
        Math.round(
          items
            .filter((i) => i.status === "won" || i.status === "busted")
            .reduce((s, i) => s + (i.plDollars ?? 0), 0) * 100,
        ) / 100,
    };

    res.json({ summary, items });
  });

  // v6.7.9: virtual parlay analytics — aggregate paper-portfolio performance
  // across all dates (win rate, staked, P/L, ROI, by day, by sport).
  app.get("/api/parlays/analytics", (_req: Request, res: Response) => {
    res.json(getVirtualParlayStats());
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

  // Calibration probe (v6.7.6). Runs one (player, market, line, side) through the
  // real pipeline (resolve → profile → simulate → edge) and returns the PA / rate
  // / distribution breakdown, so the simulator baseline can be spot-checked live.
  // Read-only. e.g. /api/props/probe?player=Trea+Turner&market=batter_hits&line=1.5&side=over
  app.get("/api/props/probe", async (req: Request, res: Response) => {
    const player = typeof req.query.player === "string" ? req.query.player.trim() : "";
    const market = typeof req.query.market === "string" ? req.query.market : "";
    const line = Number(req.query.line);
    const side = req.query.side === "under" ? "under" : "over";
    if (!player) return res.status(400).json({ message: "player is required" });
    if (!isBatterMarket(market) && !isPitcherMarket(market)) {
      return res.status(400).json({ message: `unknown market: ${market}` });
    }
    if (!Number.isFinite(line)) return res.status(400).json({ message: "line must be a number" });
    try {
      const result = await probeSimulator(player, market as PropMarket, line, side);
      res.json(result);
    } catch (err) {
      res.status(500).json({ message: (err as Error).message });
    }
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

  // v6.9.3 — DraftKings multi-leg slip loader.
  // GET /api/dk/slip?scope=parlays|sniper-singles|game&gameId=<id>
  //
  // Aggregates SNIPER selection IDs from today's picks and returns a composite
  // deep link for loading multiple legs into the DK native app or web fallback.
  // Selection IDs from the-odds-api may be null; nulls are excluded from the
  // primary deep link but surfaced in perEventLinks for graceful degradation.
  app.get("/api/dk/slip", (req: Request, res: Response) => {
    const scope = typeof req.query.scope === "string" ? req.query.scope : "parlays";
    const gameId = typeof req.query.gameId === "string" ? req.query.gameId : null;
    const date = parseDateParam(req.query.date) ?? getOperatingDay();

    if (![
      "parlays", "sniper-singles", "game",
    ].includes(scope)) {
      return res.status(400).json({ message: "scope must be parlays, sniper-singles, or game" });
    }
    if (scope === "game" && !gameId) {
      return res.status(400).json({ message: "gameId is required for scope=game" });
    }

    // Collect candidate picks depending on scope.
    // Each entry: { selectionId: string|null, eventId: string, label: string, dk: DkLinkInput }
    // dk is carried forward so perEventLinks can call pickToDkLink() with the right sport+market.
    type DkLinkInput = Parameters<typeof pickToDkLink>[0];
    type CandidateLeg = {
      selectionId: string | null;
      eventId: string;
      label: string;
      dk: DkLinkInput;
    };
    const candidates: CandidateLeg[] = [];

    if (scope === "parlays") {
      // All virtual parlay legs for today with tier=SNIPER and dk populated.
      const parlays = getVirtualParlaysForDate(date);
      for (const p of parlays) {
        let pickIds: string[] = [];
        try { pickIds = JSON.parse(p.leg_pick_ids ?? "[]") as string[]; } catch { pickIds = []; }
        for (const id of pickIds) {
          const row = getPropPick(id);
          if (!row || row.tier !== "SNIPER") continue;
          const dk = buildPropDk(row);
          if (!dk) continue;
          const sport = (row.sport ?? "mlb") as "mlb" | "nhl" | "nba" | "soccer";
          candidates.push({
            selectionId: dk.selectionId,
            eventId: dk.eventId,
            label: `${row.player_name} · ${row.market_label ?? row.market_type}`,
            dk: { sport, marketType: row.market_type },
          });
        }
      }
    } else if (scope === "sniper-singles") {
      // All SNIPER prop picks for today (game-line + props).
      const rows = propBoard({ date, tier: "ALL" }).filter((r) => r.tier === "SNIPER");
      for (const row of rows) {
        const dk = buildPropDk(row);
        if (!dk) continue;
        const sport = (row.sport ?? "mlb") as "mlb" | "nhl" | "nba" | "soccer";
        candidates.push({
          selectionId: dk.selectionId,
          eventId: dk.eventId,
          label: `${row.player_name} · ${row.market_label ?? row.market_type}`,
          dk: { sport, marketType: row.market_type },
        });
      }
    } else if (scope === "game" && gameId) {
      // All SNIPER prop picks for a single game.
      const rows = propBoard({ date, tier: "ALL" }).filter(
        (r) => r.tier === "SNIPER" && r.game_id === gameId,
      );
      for (const row of rows) {
        const dk = buildPropDk(row);
        if (!dk) continue;
        const sport = (row.sport ?? "mlb") as "mlb" | "nhl" | "nba" | "soccer";
        candidates.push({
          selectionId: dk.selectionId,
          eventId: dk.eventId,
          label: `${row.player_name} · ${row.market_label ?? row.market_type}`,
          dk: { sport, marketType: row.market_type },
        });
      }
    }

    // Deduplicate: for legs with a non-null selectionId, deduplicate by selectionId
    // so the same bet can't appear in the slip twice. For null selectionIds, deduplicate
    // by label (player+market) so the same prop pick can't appear twice via different
    // code paths, while still allowing multiple different players on the same game.
    const seen = new Set<string>();
    const deduped: CandidateLeg[] = [];
    for (const c of candidates) {
      const key = c.selectionId !== null ? `sid:${c.selectionId}` : `label:${c.label}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(c);
      }
    }

    const withId = deduped.filter((c) => c.selectionId !== null);
    const withoutId = deduped.filter((c) => c.selectionId === null);

    const selectionIds = withId.map((c) => c.selectionId as string);
    const eventIds = [...new Set(deduped.map((c) => c.eventId))];
    const skipped = withoutId.length;

    // Build composite deep links.
    const deepLink =
      selectionIds.length > 0
        ? `dk://bet?selectionIds=${selectionIds.join(",")}`
        : null;
    const webFallback =
      selectionIds.length > 0
        ? `https://sportsbook.draftkings.com/?selectionIds=${selectionIds.join(",")}`
        : null;

    // Per-event fallback links for picks without selection IDs.
    // v6.9.5: use https universal links — iOS routes these to the DK app (or web)
    // without invalid-address errors.
    const perEventLinks = withoutId.map((c) => ({
      eventId: c.eventId,
      deepLink: c.dk ? pickToDkLink(c.dk) : pickToDkLink({ sport: "mlb" }),
      label: c.label,
    }));

    return res.json({
      scope,
      date,
      selectionIds,
      eventIds,
      count: selectionIds.length,
      skipped,
      skippedReason:
        skipped > 0
          ? "null selection id (fallback to sport-level deep link)"
          : null,
      deepLink,
      webFallback,
      perEventLinks,
    });
  });


  app.get("/api/debug/odds-probe", async (_req: Request, res: Response) => {
    const key = process.env.ODDS_API_KEY;
    if (!key) return res.status(500).json({ error: "no ODDS_API_KEY env" });

    const BASE = "https://api.the-odds-api.com/v4/sports";
    const out: any = { keyFirst4: key.slice(0, 4), keyLength: key.length };

    try {
      // 1. Sports list
      const sportsRes = await fetch(`${BASE}/?apiKey=${key}`);
      out.sportsStatus = sportsRes.status;
      out.quotaRemaining = sportsRes.headers.get("x-requests-remaining");
      out.quotaUsed = sportsRes.headers.get("x-requests-used");
      const sports = await sportsRes.json();
      out.baseballSports = Array.isArray(sports)
        ? sports.filter((s: any) => s.key?.includes("baseball")).map((s: any) => ({ key: s.key, active: s.active, hasOutrights: s.has_outrights }))
        : { error: sports };

      // 2. MLB events
      const eventsRes = await fetch(`${BASE}/baseball_mlb/events?apiKey=${key}`);
      out.eventsStatus = eventsRes.status;
      out.eventsQuotaRemaining = eventsRes.headers.get("x-requests-remaining");
      const events = await eventsRes.json();
      out.eventsCount = Array.isArray(events) ? events.length : null;
      out.eventsSample = Array.isArray(events)
        ? events.slice(0, 5).map((e: any) => ({ commence: e.commence_time, away: e.away_team, home: e.home_team }))
        : { error: events };

      // 3. MLB odds with our exact markets (h2h + F5)
      const fullUrl = `${BASE}/baseball_mlb/odds/?apiKey=${key}&regions=us&markets=h2h,spreads,totals,h2h_1st_5_innings,totals_1st_5_innings,spreads_1st_5_innings&oddsFormat=american`;
      const oddsRes = await fetch(fullUrl);
      out.fullOddsStatus = oddsRes.status;
      out.fullOddsQuotaRemaining = oddsRes.headers.get("x-requests-remaining");
      const odds = await oddsRes.json();
      out.fullOddsCount = Array.isArray(odds) ? odds.length : null;
      out.fullOddsSample = Array.isArray(odds)
        ? odds.slice(0, 3).map((e: any) => ({ commence: e.commence_time, teams: `${e.away_team} @ ${e.home_team}`, books: e.bookmakers?.length || 0 }))
        : { error: odds };

      // 4. MLB odds WITHOUT F5 (in case F5 markets are unsupported on free plan)
      const baseUrl = `${BASE}/baseball_mlb/odds/?apiKey=${key}&regions=us&markets=h2h,spreads,totals&oddsFormat=american`;
      const baseOddsRes = await fetch(baseUrl);
      out.baseOddsStatus = baseOddsRes.status;
      out.baseOddsQuotaRemaining = baseOddsRes.headers.get("x-requests-remaining");
      const baseOdds = await baseOddsRes.json();
      out.baseOddsCount = Array.isArray(baseOdds) ? baseOdds.length : null;
      out.baseOddsSample = Array.isArray(baseOdds)
        ? baseOdds.slice(0, 3).map((e: any) => ({ commence: e.commence_time, teams: `${e.away_team} @ ${e.home_team}`, books: e.bookmakers?.length || 0 }))
        : { error: baseOdds };
    } catch (e: any) {
      out.error = String(e.message || e);
    }

    res.json(out);
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
