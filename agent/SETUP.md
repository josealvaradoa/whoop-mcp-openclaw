# Setting Up Your Ironman Training Coach in Claude

## Prerequisites

- A deployed whoop-ironman-mcp server (local or Railway)
- Your MCP server URL (e.g., `https://your-app.railway.app` or `http://localhost:3000`)
- Your MCP bearer token (the `MCP_BEARER_TOKEN` value from your `.env`)
- A completed Whoop OAuth flow (visit `/auth/whoop` to connect your Whoop account)

## Steps

### 1. Create a Claude Project

1. Go to [claude.ai](https://claude.ai)
2. Click **Projects** in the left sidebar
3. Click **New Project**
4. Name it something like "Ironman Training Coach"

### 2. Set Custom Instructions

1. In your new Project, click **Project Settings** (gear icon)
2. Find the **Custom Instructions** section
3. Copy the entire contents of `SYSTEM_PROMPT.md` and paste it in
4. Save

### 3. Upload Knowledge Files

1. In Project Settings, find the **Knowledge** section
2. Upload two files:
   - `TRAINING_CONTEXT.md` — fill this in with your personal details first (age, race, fitness level, injuries, schedule)
   - `PERIODIZATION_GUIDE.md` — upload as-is (reference material for Claude)

### 4. Add the MCP Custom Connector

1. Go to **Settings** (top-right menu) → **Custom Connectors**
2. Click **Add Connector**
3. Enter your MCP server URL: `https://your-app.railway.app/mcp`
4. Set the Authorization header: `Bearer your-mcp-bearer-token`
5. Save

### 5. Verify It Works

1. Start a new conversation in your Ironman Training Coach project
2. Ask: **"What should I do today?"**
3. Claude should:
   - Call `get_today_overview` to check your recovery and sleep
   - Call `get_training_load` to check your ACWR
   - Give you a specific training recommendation based on your data

### Troubleshooting

- **Claude doesn't call tools**: Make sure the Custom Connector URL ends with `/mcp` and the bearer token matches your `MCP_BEARER_TOKEN` env var.
- **"No tokens stored" error**: Visit `/auth/whoop` on your server to connect your Whoop account.
- **"Token expired" error**: Visit `/auth/whoop` again to re-authorize. Whoop tokens expire periodically.
- **No data returned**: Make sure you've been wearing your Whoop for at least a few days. The tools need historical data for trend calculations.
