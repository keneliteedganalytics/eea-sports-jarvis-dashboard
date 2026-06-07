import type { Express, Request, Response } from "express";
import type { Server } from "node:http";
import fs from "node:fs";
import { initSchema } from "./storage";
import { getSlate, getPick } from "./sports/mlb/slate";
import { hitRatesByTier, trackRecord, seedHitRates } from "./sports/mlb/trackRecord";
import { generateBrief } from "./audio/brief";
import { generateSpeech, getCachedFilePath, hasElevenLabsKey } from "./audio/tts";
import { getAlerts } from "./pollers/alerts";
import { startOddsPoller } from "./pollers/oddsPoller";
import { startScratchPoller } from "./pollers/scratchPoller";
import { BANKROLL_USD } from "./sports/mlb/picksEngine";

const STUB_SPORTS = ["nhl", "nba", "ncaaf", "ncaab", "nfl"];

function bankroll(): number {
  const n = Number(process.env.BANKROLL_USD);
  return Number.isFinite(n) && n > 0 ? n : BANKROLL_USD;
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  initSchema();
  seedHitRates("MLB");
  startOddsPoller();
  startScratchPoller();

  // Today's MLB slate (capped, tiered picks).
  app.get("/api/mlb/slate", async (_req: Request, res: Response) => {
    const slate = await getSlate(bankroll());
    res.json(slate);
  });

  // Single pick detail.
  app.get("/api/mlb/pick/:id", async (req: Request, res: Response) => {
    const pick = await getPick(String(req.params.id), bankroll());
    if (!pick) return res.status(404).json({ message: "pick not found" });
    res.json(pick);
  });

  // Hit-rate cache (per-tier 30/60/90).
  app.get("/api/mlb/hit-rates", (_req: Request, res: Response) => {
    res.json(hitRatesByTier("MLB"));
  });

  // Track Record summary + bet log.
  app.get("/api/mlb/track-record", (_req: Request, res: Response) => {
    res.json(trackRecord("MLB"));
  });

  // Alerts (steam / scratch). ?since=<id> for incremental polling.
  app.get("/api/alerts", (req: Request, res: Response) => {
    const since = Number(req.query.since ?? 0);
    res.json(getAlerts(Number.isFinite(since) ? since : 0));
  });

  // Generate (or fetch cached) audio brief for a pick. Returns { audioUrl,
  // text, available } — available=false means no ElevenLabs key (UI shows the
  // brief text without playback).
  app.post("/api/mlb/brief/:id", async (req: Request, res: Response) => {
    const pick = await getPick(String(req.params.id), bankroll());
    if (!pick) return res.status(404).json({ message: "pick not found" });
    const text = await generateBrief(pick, bankroll());
    if (!hasElevenLabsKey()) {
      return res.json({ text, audioUrl: null, available: false });
    }
    try {
      const speech = await generateSpeech(text);
      res.json({ text, audioUrl: speech.audioUrl, available: true, cached: speech.cached });
    } catch (e) {
      res.json({ text, audioUrl: null, available: false, error: e instanceof Error ? e.message : "tts failed" });
    }
  });

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
