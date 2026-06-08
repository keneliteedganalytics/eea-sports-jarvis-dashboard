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
BANKROLL_USD=35800
NODE_ENV=production
```

## Custom domain + Cloudflare Access
1. Railway → Settings → Networking → Generate Domain (gives e.g. eea-sports-jarvis-production.up.railway.app)
2. In Cloudflare DNS for eliteedgeanalytics.com:
   - CNAME `sports` → the Railway public hostname (proxied / orange cloud)
3. Cloudflare Zero Trust → Access → Applications → Add `sports.eliteedgeanalytics.com`, restrict to your email (same as `jarvis.eliteedgeanalytics.com`)
4. Railway → Settings → Networking → Custom Domain → add `sports.eliteedgeanalytics.com`

## Auto-deploy
Push to `master` → Railway rebuilds and deploys within ~90s. Mirror of how horse-jarvis works.

## Health check
`GET /api/slate?date=YYYY-MM-DD` returns 200 with the day's picks JSON. Point Railway's Healthcheck Path at `/api/slate` if desired.
