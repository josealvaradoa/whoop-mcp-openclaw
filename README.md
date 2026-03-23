# whoop-ironman-mcp

A remote MCP server that connects Whoop fitness tracker data to Claude for AI-powered Ironman 70.3 training coaching.

<!-- TODO: Add hero screenshot of Claude mobile showing a training recommendation -->

## What It Does

- Pulls real-time biometric data from your Whoop (recovery, HRV, sleep, strain, workouts)
- Computes training metrics: ACWR, sleep debt, recovery trends, race readiness
- Exposes 7 MCP tools that Claude can call to make daily training recommendations
- Includes a Claude Project template that turns Claude into an Ironman 70.3 coach

## Architecture

```
Claude (mobile / desktop / claude.ai)
        |
        v  HTTPS + SSE (Custom Connector)
+--------------------------------------+
|     whoop-ironman-mcp                |
|     (Node.js + TypeScript)           |
|                                      |
|  Express HTTP Server                 |
|  - /mcp (Streamable HTTP transport)  |
|  - /auth/whoop (OAuth start)        |
|  - /auth/whoop/callback             |
|  - Bearer token middleware           |
|                                      |
|  MCP Server                          |
|  - 7 registered tools               |
|  - Stateful session management       |
|                                      |
|  Whoop API Client (v2)              |
|  - OAuth 2.0 auth code flow         |
|  - Token encryption (AES-256-GCM)   |
|  - Cache-first with TTL             |
|                                      |
|  Compute Layer                       |
|  - ACWR, monotony, trends           |
|  - Sleep debt, HRV analysis         |
|  - Race readiness scoring           |
|                                      |
|  SQLite (better-sqlite3)            |
|  - Encrypted OAuth tokens           |
|  - Cached API responses             |
+--------------------------------------+
        |
        v  HTTPS
   Whoop API v2
```

## Deploy on Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template)

> After deploying, set your environment variables in the Railway dashboard and attach a persistent volume at `/app/data` for SQLite.

## Quick Start

1. **Clone and install**
   ```bash
   git clone https://github.com/yourusername/whoop-ironman-mcp.git
   cd whoop-ironman-mcp
   corepack enable
   pnpm install
   ```

2. **Configure**
   ```bash
   cp .env.example .env
   # Edit .env with your Whoop OAuth credentials from developer.whoop.com
   # Set ENCRYPTION_SECRET (32+ chars) and MCP_BEARER_TOKEN
   ```

3. **Build and start**
   ```bash
   pnpm run build
   node dist/index.js
   ```

4. **Connect your Whoop account**

   Open `http://localhost:3000/auth/whoop` in your browser and authorize.

5. **Connect Claude**

   In Claude.ai, go to Settings > Custom Connectors > Add your server URL (`http://localhost:3000/mcp`) with your bearer token.

6. **Ask Claude**: "What should I do today?"

## MCP Tools Reference

| Tool | Description |
|------|-------------|
| `get_today_overview` | Recovery score, HRV, RHR, sleep, strain with readiness assessment |
| `get_training_load` | ACWR, monotony, acute/chronic load, trend direction |
| `get_recovery_trend` | Rolling averages, consecutive green/yellow/red days |
| `get_sleep_trend` | Duration, efficiency, cumulative sleep debt, consistency |
| `get_hrv_trend` | Baseline, coefficient of variation, trend direction |
| `get_workouts` | Workout history with sport filtering and zone distribution |
| `get_race_readiness` | Phase detection, fitness trend, fatigue, concerns, weekly summary |

## Configuration

### Environment Variables (`.env`)

| Variable | Description |
|----------|-------------|
| `WHOOP_CLIENT_ID` | From developer.whoop.com |
| `WHOOP_CLIENT_SECRET` | From developer.whoop.com |
| `WHOOP_REDIRECT_URI` | OAuth callback URL (default: `http://localhost:3000/auth/whoop/callback`) |
| `ENCRYPTION_SECRET` | 32+ character secret for token encryption (AES-256-GCM) |
| `MCP_BEARER_TOKEN` | Static token for authenticating MCP requests from Claude |
| `PORT` | Server port (default: 3000) |
| `NODE_ENV` | `development` or `production` |

### Training Config (`whoop-mcp.config.json`)

Copy `whoop-mcp.config.example.json` to `whoop-mcp.config.json` and customize:

- **athlete**: Name, sleep target, max HR
- **race**: Race name, date, training phases with date ranges
- **thresholds**: ACWR danger/optimal zones, recovery color thresholds, HRV concern levels
- **cache**: TTL and history window

## Training Agent Setup

See [agent/SETUP.md](agent/SETUP.md) for step-by-step instructions to set up Claude as your Ironman training coach.

## Development

### Run locally

```bash
pnpm run dev          # Start with tsx (hot reload)
pnpm run build        # Compile TypeScript
pnpm run start        # Run compiled JS
pnpm run typecheck    # Type check without emitting
pnpm run lint         # ESLint
```

### Project structure

```
src/
  index.ts              Entry point
  server.ts             Express app, OAuth routes, bearer middleware
  config.ts             Config loader and validator
  whoop/
    auth.ts             OAuth flow, token encryption (AES-256-GCM)
    client.ts           Whoop API v2 client with pagination and caching
    types.ts            TypeScript types for Whoop API responses
  db/
    connection.ts       SQLite singleton (better-sqlite3, WAL mode)
    schema.ts           Table definitions (tokens, cache)
    cache.ts            TTL-based cache read/write/cleanup
  compute/
    training-load.ts    ACWR, monotony, trend direction
    recovery.ts         Recovery trends, readiness, baseline comparison
    sleep.ts            Sleep debt, consistency, duration trends
    hrv.ts              HRV baseline, coefficient of variation
    race-readiness.ts   Phase detection, fitness/fatigue assessment
  mcp/
    setup.ts            MCP server, session management, tool registration
    tools/              7 tool implementations
agent/
  SYSTEM_PROMPT.md      Claude coaching persona instructions
  TRAINING_CONTEXT.md   Athlete profile template
  PERIODIZATION_GUIDE.md  Training reference document
  SETUP.md              How to set up the Claude Project
```

## How the Computed Metrics Work

### ACWR (Acute-to-Chronic Workload Ratio)
Compares your last 7 days of training strain to your 28-day average. Values between 0.8-1.3 are optimal. Above 1.5 signals injury risk. Below 0.8 means you're undertrained.

### Training Monotony
How repetitive your training is. High monotony (> 2.0) means every day looks the same — your body needs variety to adapt without breaking down.

### Sleep Debt
Cumulative difference between actual sleep and your target over 7 days. A debt of -4.5 hours means you've under-slept by almost a full night's worth in a week.

### Race Readiness
Combines ACWR, recovery trend, HRV, sleep, and your training phase to produce a single assessment: fitness trend (on track, undertrained, overreaching, injury risk), fatigue status, and specific concerns to address.

## License

MIT
