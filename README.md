# Sports Jarvis — MLB Dashboard

A full-stack TypeScript betting desk that ports the canonical Python `sports-engine`
MLB pipeline into a web app, fronted by a gold/navy "Sharp Desk Analyst" UI with
optional Jarvis voice briefs. Calm, institutional, quantitative — never hype.

## Stack

- **Server:** Express 5 + Vite 7 middleware, `tsx` in dev, esbuild → `dist/index.cjs` in prod
- **Client:** React 18 + Wouter (hash routing) + Tailwind 3 + shadcn/ui
- **Data:** Drizzle ORM + better-sqlite3 (synchronous; `data.db`)
- **Audio:** ElevenLabs TTS (cached by sha256), Anthropic Claude for brief copy

The app **boots with zero API keys.** Without an Odds API key it serves a deterministic
demo slate and a seeded track record so the entire UI renders end to end. Briefs fall
back to a deterministic template when Claude/ElevenLabs are not configured.

## Quick start

```bash
npm install
cp .env.example .env   # fill in keys when you have them — all optional
npm run dev            # http://localhost:5000
```

Other scripts:

```bash
npm run build   # client bundle + dist/index.cjs
npm start       # production server
npm test        # betting-math unit tests (tsx + node:assert)
npm run check   # typecheck
```

## Configuration

All keys live in the environment; see `.env.example`. Every adapter is gated on its
key and degrades gracefully when it is absent.

| Var | Purpose |
| --- | --- |
| `ODDS_API_KEY` | Live moneyline odds (drives live vs. demo slate) |
| `API_SPORTS_KEY` | Team offense ratings |
| `OPENWEATHER_API_KEY` | Park weather refinement |
| `ANTHROPIC_API_KEY` | LLM-written analyst briefs (else template) |
| `ELEVENLABS_API_KEY` | Voice briefs (else text-only) |
| `BANKROLL_USD` | Stake sizing base (default 29000) |

## Engine

The model ports the locked `sports-engine` math: Shin de-vig, american↔prob↔decimal
conversions, Pythagenpat run expectancy, FIP, park factors, a bullpen dampener, a
stale-line trap detector, and an elite-pitcher fade. Stakes use quarter-Kelly with a
3% bankroll hard cap, surfaced as conviction units. Picks are graded into a tier
ladder (BONUS → SNIPER → EDGE → RECON → VALUE → LEAN → PASS) with a 7-component
confidence score and a 6-pick daily cap (surplus downgraded to LEAN).

## Routes

- `/` — today's board: pick cards, slate filters (Sport · Tier · Min Edge · Sort)
- `/pick/:id` — full breakdown: 3-bar signals, line history, why panel, brief player
- `/track-record` — CLV / EV / ROI / drawdown, hit rate by tier, graded book
- `/sports/:sport` — coming-soon stubs for other leagues

## Tests

`npm test` asserts the locked invariants: `americanToProb(-150) ≈ 0.60`,
`assignTier` returns `BONUS` at edge 8.5pp / conf 82 / poly 65, `kellyFraction`
is positive on a real edge, and the quarter-Kelly 3% cap holds on an oversized edge.
