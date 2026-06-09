# Deploying EEA Sports Jarvis to Railway

Same pattern as horse-jarvis → jarvis.eliteedgeanalytics.com.

## One-time setup
1. railway.app → New Project → Deploy from GitHub
2. Pick `keneliteedganalytics/eea-sports-jarvis-dashboard`, branch `master`
3. Railway auto-detects Node, runs `npm ci && npm run build`, starts via `npm run start`
4. Server binds to `process.env.PORT` (Railway injects this — see server/index.ts:94)

## Environment variables (Settings → Variables)
Paste these into Railway's variables pane:

```
ODDS_API_KEY=<your-odds-api-key>
API_SPORTS_KEY=<your-api-sports-key>
ANTHROPIC_API_KEY=<your-anthropic-key>
ELEVENLABS_API_KEY=<your-elevenlabs-key>
ELEVENLABS_VOICE_ID=onwK4e9ZLuTAKqWW03F9
ELEVENLABS_MODEL=eleven_turbo_v2_5
OPENWEATHER_API_KEY=<your-openweather-key>
BALLDONTLIE_API_KEY=<your-balldontlie-key>
BANKROLL_USD=25000
NODE_ENV=production
```

> **Bankroll (June 2026 reset):** `BANKROLL_USD=25000`. One flat unit is 1.5% of
> bankroll = **$375**. Conviction stakes: BONUS 3.0u = $1,125 · SNIPER 2.5u = $938
> · EDGE 2.0u = $750 · RECON 1.5u = $563 · VALUE/LEAN 1.0u = $375. The route reads
> `process.env.BANKROLL_USD` and falls back to the repo default (also 25000). Update
> the Railway variable to change it in production — no code change required.

## Custom domain + Cloudflare Access
1. Railway → Settings → Networking → Generate Domain (gives e.g. eea-sports-jarvis-production.up.railway.app)
2. In Cloudflare DNS for eliteedgeanalytics.com:
   - CNAME `sports` → the Railway public hostname (proxied / orange cloud)
3. Cloudflare Zero Trust → Access → Applications → Add `sports.eliteedgeanalytics.com`, restrict to your email (same as `jarvis.eliteedgeanalytics.com`)
4. Railway → Settings → Networking → Custom Domain → add `sports.eliteedgeanalytics.com`

## Auto-deploy
Push to `master` → Railway rebuilds and deploys within ~90s. Mirror of how horse-jarvis works.

## Graded book (live scoring + auto-grading)
The desk's settled record lives in a SQLite file, path configurable via
`GRADED_BOOK_PATH` (defaults to `data/graded_book.db`). Every actionable pick the
slate surfaces is written here; a background job polls the public ESPN scoreboard
every 15 minutes, attaches live scores, and grades each pick (W/L/P + P/L) when its
game goes final. There is no seed data — Track Record / Analytics / Yesterday are
empty until real picks settle against real final scores.

- Manual grade pass: `POST /api/admin/poll-now?date=YYYY-MM-DD` (no auth).
- Backfill a past day locally: `tsx server/scripts/backfillYesterday.ts YYYY-MM-DD`.

> **Follow-up (Railway ephemeral disk):** Railway's container filesystem is
> ephemeral, so `data/graded_book.db` resets on each redeploy. Add a Railway
> **Volume** mounted at `/app/data` and set `GRADED_BOOK_PATH=/app/data/graded_book.db`
> so the graded history survives deploys. Tracked as a follow-up; the file path is
> already env-configurable for this.

## Health check
`GET /api/slate?date=YYYY-MM-DD` returns 200 with the day's picks JSON. Point Railway's Healthcheck Path at `/api/slate` if desired.
