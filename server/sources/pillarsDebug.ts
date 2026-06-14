// v6.9.0 — read-only debug surface for the five Foxtail pillars. These endpoints
// let us probe each new data layer live without touching pick behavior (the
// pillars ship SHADOW-gated). All are GET, best-effort, and never mutate state.
//
//   GET /api/debug/recent-form?pitcherId=&hitterId=   → Pillar 1 rolling forms
//   GET /api/debug/injuries?teamId=&gamePk=&side=     → Pillar 2 IL/lineup read
//   GET /api/games/:id/distribution?a=&b=&total=      → Pillar 3 run distribution
//   GET /api/debug/pitch-mix                          → Pillar 4 arsenal sample
//   GET /api/debug/bullpen-load?teamId=               → Pillar 5 3-day fatigue
//   GET /api/picks/debug?a=&b=&total=&pitcherId=&teamId=&gamePk=&side=
//                                                     → consolidated contributions

import type { Express, Request, Response } from "express";
import { pitcherRecentForm, hitterRecentForm } from "./recentForm";
import { fetchInjuryListIds, fetchBattingOrders } from "./injuries";
import { bullpenLoadForTeam } from "./bullpenLoad";
import { fetchPitcherArsenals } from "./pitchMix";
import { simulateRunDistribution } from "../sim/runDistribution";

function numParam(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

export function registerPillarDebugRoutes(app: Express): void {
  // Pillar 1 — player recent form.
  app.get("/api/debug/recent-form", async (req: Request, res: Response) => {
    const pitcherId = numParam(req.query.pitcherId);
    const hitterId = numParam(req.query.hitterId);
    const [pitcher, hitter] = await Promise.all([
      pitcherRecentForm(pitcherId),
      hitterRecentForm(hitterId),
    ]);
    res.json({ pillar: "recent-form", pitcher, hitter });
  });

  // Pillar 2 — injury / lineup ingest (raw IL ids + posted batting orders).
  app.get("/api/debug/injuries", async (req: Request, res: Response) => {
    const teamId = numParam(req.query.teamId);
    const gamePk = req.query.gamePk ? String(req.query.gamePk) : null;
    const [il, orders] = await Promise.all([
      fetchInjuryListIds(teamId),
      fetchBattingOrders(gamePk),
    ]);
    res.json({
      pillar: "injuries",
      teamId,
      gamePk,
      injuryListIds: [...il],
      battingOrders: orders,
    });
  });

  // Pillar 3 — score-distribution Monte Carlo for arbitrary projected runs.
  app.get("/api/games/:id/distribution", (req: Request, res: Response) => {
    const a = numParam(req.query.a) ?? 4.5;
    const b = numParam(req.query.b) ?? 4.5;
    const total = numParam(req.query.total);
    const iterations = numParam(req.query.iterations) ?? undefined;
    const dist = simulateRunDistribution({
      projRunsA: a, projRunsB: b, overUnderLine: total, iterations: iterations ?? undefined,
    });
    res.json({ pillar: "run-distribution", gameId: req.params.id, projRunsA: a, projRunsB: b, distribution: dist });
  });

  // Pillar 4 — pitch-mix arsenals (sample so we don't dump the whole league).
  app.get("/api/debug/pitch-mix", async (req: Request, res: Response) => {
    const arsenals = await fetchPitcherArsenals();
    const pitcherId = numParam(req.query.pitcherId);
    if (pitcherId !== null) {
      return res.json({ pillar: "pitch-mix", pitcherId, arsenal: arsenals.get(pitcherId) ?? null });
    }
    const sample = [...arsenals.values()].slice(0, 5);
    res.json({ pillar: "pitch-mix", count: arsenals.size, sample });
  });

  // Pillar 5 — bullpen 3-day load / fatigue.
  app.get("/api/debug/bullpen-load", async (req: Request, res: Response) => {
    const teamId = numParam(req.query.teamId);
    const load = await bullpenLoadForTeam(teamId);
    res.json({ pillar: "bullpen-load", teamId, load });
  });

  // Consolidated: every pillar's contribution for a hypothetical game/side.
  app.get("/api/picks/debug", async (req: Request, res: Response) => {
    const a = numParam(req.query.a) ?? 4.5;
    const b = numParam(req.query.b) ?? 4.5;
    const total = numParam(req.query.total);
    const pitcherId = numParam(req.query.pitcherId);
    const hitterId = numParam(req.query.hitterId);
    const teamId = numParam(req.query.teamId);
    const gamePk = req.query.gamePk ? String(req.query.gamePk) : null;

    const [pitcher, hitter, bullpen, ilIds, orders] = await Promise.all([
      pitcherRecentForm(pitcherId),
      hitterRecentForm(hitterId),
      bullpenLoadForTeam(teamId),
      fetchInjuryListIds(teamId),
      fetchBattingOrders(gamePk),
    ]);
    const distribution = simulateRunDistribution({
      projRunsA: a, projRunsB: b, overUnderLine: total, fatigueB: bullpen.fatigue,
    });

    res.json({
      pillars: {
        recentForm: { pitcher, hitter },
        injuries: { teamId, injuryListCount: ilIds.size, battingOrders: orders },
        runDistribution: distribution,
        bullpenLoad: bullpen,
        pitchMix: { note: "see /api/debug/pitch-mix?pitcherId=" },
      },
    });
  });
}
