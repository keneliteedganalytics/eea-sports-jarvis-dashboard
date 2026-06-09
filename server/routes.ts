import type { Express, Request, Response } from "express";
import type { Server } from "node:http";
import fs from "node:fs";
import { initSchema } from "./storage";
import { getSlate } from "./sports/mlb/slate";
import { getNhlSlate } from "./sports/nhl/slate";
import { getNbaSlate } from "./sports/nba/slate";
import { getDailySlate, getAnyPick } from "./slate/orchestrator";
import { getProps } from "./props";
import { hitRatesByTier, trackRecord } from "./sports/mlb/trackRecord";
import { buildAnalytics } from "./analytics";
import { generateBrief } from "./audio/brief";
import { generateSpeech, getCachedFilePath, hasElevenLabsKey } from "./audio/tts";
import { getAlerts } from "./pollers/alerts";
import { startOddsPoller } from "./pollers/oddsPoller";
import { startScratchPoller } from "./pollers/scratchPoller";
import { startLiveScoring, pollEspnAndUpdate } from "./jobs/liveScoring";
import { confirmBet } from "./gradedBook";
import { BANKROLL_USD } from "./sports/mlb/picksEngine";

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

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  initSchema();
  startOddsPoller();
  startScratchPoller();
  startLiveScoring();

  // Unified cross-sport board (MLB + NHL + NBA). ?date=YYYY-MM-DD overrides the
  // operating day so historical/forward slates can be inspected.
  app.get("/api/slate", async (req: Request, res: Response) => {
    const dateIso = parseDateParam(req.query.date);
    const slate = await getDailySlate(bankroll(), dateIso);
    res.json(slate);
  });

  // Today's MLB slate (capped, tiered picks).
  app.get("/api/mlb/slate", async (_req: Request, res: Response) => {
    const slate = await getSlate(bankroll());
    res.json(slate);
  });

  // NHL + NBA slates.
  app.get("/api/nhl/slate", async (_req: Request, res: Response) => {
    res.json(await getNhlSlate(bankroll()));
  });
  app.get("/api/nba/slate", async (_req: Request, res: Response) => {
    res.json(await getNbaSlate(bankroll()));
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
