# OpenClaw Railway Template (1‑click deploy)

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https://github.com/lynnzc/clawdbot-railway-template)

This repo packages **[OpenClaw](https://github.com/openclaw/openclaw)** for Railway with a beautiful **/setup** web wizard so you can deploy your personal AI assistant **without touching the command line**.

**Version:** Compatible with OpenClaw 2026.2.6+

## What you get

- **OpenClaw Gateway + Control UI** (served at `/` and `/openclaw`)
- **Modern Setup Wizard** at `/setup` (password-protected, beautiful UI)
- **Persistent Storage** via Railway Volume (config/credentials/memory survive redeploys)
- **Backup & Restore** - One-click export/import for easy migration
- **Debug Console** - Run diagnostics and view logs from the browser
- **Config Editor** - Edit your OpenClaw config with live reload
- **Auto-start Gateway** - Wrapper manages the gateway lifecycle automatically

## What's new in this version

- Updated to OpenClaw 2026.2.6+ with latest auth providers
- Modern, gradient UI with improved UX
- Better error handling and stability
- Enhanced health monitoring
- Support for new providers: Venice AI, Moonshot (CN), and more

## How it works

1. **Container runs a wrapper server** - Manages OpenClaw lifecycle and provides the setup UI
2. **Setup wizard** - Protected by `SETUP_PASSWORD`, runs `openclaw onboard` non-interactively
3. **Gateway management** - Automatically starts/restarts the OpenClaw gateway
4. **Reverse proxy** - All traffic (including WebSockets) is proxied to the gateway
5. **Persistent volumes** - Your data survives redeploys via Railway's volume system

## Railway deploy instructions (what you’ll publish as a Template)

In Railway Template Composer:

1) Create a new template from this GitHub repo.
2) Add a **Volume** mounted at `/data`.
3) Set the following variables:

Required:
- `SETUP_PASSWORD` — user-provided password to access `/setup`

Recommended:
- `OPENCLAW_STATE_DIR=/data/.openclaw`
- `OPENCLAW_WORKSPACE_DIR=/data/workspace`

Optional:
- `OPENCLAW_GATEWAY_TOKEN` — if not set, the wrapper generates one (not ideal). In a template, set it using a generated secret.

**Important notes:**
- This template builds OpenClaw from source to ensure all features work correctly
- Default build uses `main` branch (latest). Pin to a specific tag via `OPENCLAW_GIT_REF` for stability
- **Backward compatibility:** Legacy `CLAWDBOT_*` environment variables are supported with deprecation warnings
- Requires **Node 22.12+** and **pnpm 10.23+** (handled automatically in Docker)

4) Enable **Public Networking** (HTTP). Railway will assign a domain.
   - This service is configured to listen on port `8080` (including custom domains).
5) Deploy.

Then:
- Visit `https://<your-app>.up.railway.app/setup`
- Complete setup
- Visit `https://<your-app>.up.railway.app/` and `/openclaw`

## Getting chat tokens (so you don’t have to scramble)

### Telegram bot token
1) Open Telegram and message **@BotFather**
2) Run `/newbot` and follow the prompts
3) BotFather will give you a token that looks like: `123456789:AA...`
4) Paste that token into `/setup`

### Discord bot token
1) Go to the Discord Developer Portal: https://discord.com/developers/applications
2) **New Application** → pick a name
3) Open the **Bot** tab → **Add Bot**
4) Copy the **Bot Token** and paste it into `/setup`
5) Invite the bot to your server (OAuth2 URL Generator → scopes: `bot`, `applications.commands`; then choose permissions)

## Local smoke test

```bash
docker build -t openclaw-railway-template .

docker run --rm -p 8080:8080 \
  -e PORT=8080 \
  -e SETUP_PASSWORD=test \
  -e OPENCLAW_STATE_DIR=/data/.openclaw \
  -e OPENCLAW_WORKSPACE_DIR=/data/workspace \
  -v $(pwd)/.tmpdata:/data \
  openclaw-railway-template

# open http://localhost:8080/setup (password: test)
```

## FAQ

### Which auth provider should I choose?

**For most users:**
- **Anthropic (Recommended)** - Best reliability, uses Claude. Get an API key from [console.anthropic.com](https://console.anthropic.com)
- **OpenAI** - Great alternative, uses GPT-4. Get an API key from [platform.openai.com](https://platform.openai.com)

**For advanced users:**
- **OpenRouter** - Access multiple AI models with one API key
- **Gemini** - Google's AI models, free tier available

### How do I get messaging bot tokens?

**Telegram:**
1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow prompts
3. Copy the token (format: `123456789:ABC...`)

**Discord:**
1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create New Application → Bot tab → Add Bot
3. Copy Bot Token
4. **Important:** Enable MESSAGE CONTENT INTENT in Bot settings

### The gateway won't start, what should I do?

1. Check `/setup/healthz` endpoint for status
2. Use the Debug Console in `/setup` to run `openclaw doctor`
3. View logs with `openclaw logs --tail 200`
4. Try "Restart Gateway" button in the Debug Console

### Can I migrate my data off Railway?

Yes! Use the **Download backup** link in `/setup` to export a `.tar.gz` archive containing all your data. You can import this on another deployment or run OpenClaw locally.

---

## Official template / endorsements

- Officially recommended by OpenClaw: <https://docs.openclaw.ai/railway>
- Railway announcement (official): [Railway tweet announcing 1‑click OpenClaw deploy](https://x.com/railway/status/2015534958925013438)

  ![Railway official tweet screenshot](assets/railway-official-tweet.jpg)

- Endorsement from Railway CEO: [Jake Cooper tweet endorsing the OpenClaw Railway template](https://x.com/justjake/status/2015536083514405182)

  ![Jake Cooper endorsement tweet screenshot](assets/railway-ceo-endorsement.jpg)

- Created and maintained by **Vignesh N (@vignesh07)**
- **1800+ deploys on Railway and counting** [Link to template on Railway](https://railway.com/deploy/clawdbot-railway-template)

![Railway template deploy count](assets/railway-deploys.jpg)
