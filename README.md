# LookShift MVP

Live fashion impact coach: **Vonage** (or camera preview) + **Gemini** multi-agent pipeline.
No Google Vision. No sign-up.

## Architecture

- `apps/web` — split-screen web UI (Flutter not required to run this MVP)
- `services/api` — rooms, Vonage tokens, WebSocket, Gemini agents
  - Outfit Agent → Risk Agent → Alternative Outfit Agent

## Quick start

### 1) API

```bash
cd services/api
cp .env.example .env
# add GEMINI_API_KEY (Vonage optional for demo)
npm install
npm run dev
```

API: `http://localhost:8787`

Without keys:
- Rooms still work
- Camera preview mode (no Vonage)
- Demo analysis payload if Gemini is missing

### 2) Web

```bash
cd apps/web
npm install
npm run dev
```

Open `http://localhost:5173` → **Create room** → allow camera.

Snapshots upload every ~5s and the right pane updates with a healthier/greener alternative.

## Env

| Var | Required | Purpose |
|-----|----------|---------|
| `GEMINI_API_KEY` | for real AI | Outfit/risk/alternative |
| `VONAGE_APPLICATION_ID` | for real multi-party video | Video sessions |
| `VONAGE_PRIVATE_KEY` or `_PATH` | with Vonage | Token minting |
| `GEMINI_IMAGE_MODEL` | optional | Generate alternative outfit image |

## Flutter note

Flutter was not installed on this machine, so the runnable frontend is `apps/web`.
Same UX/architecture; a Flutter Web client can replace it later using the same API.
