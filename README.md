# OpenClaw Railway Template (1‑click deploy)

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/openclaw-clawdbot-railway-template?referralCode=lNjnrx&utm_medium=integration&utm_source=template&utm_campaign=generic)

This repo packages **[OpenClaw](https://github.com/openclaw/openclaw)** for Railway with a beautiful **/setup** web wizard so you can deploy your personal AI assistant **without touching the command line**.

**Version:** Compatible with OpenClaw 2026.2.6+

## What you get

- **OpenClaw Gateway + Control UI** (served at `/` and `/openclaw`)
- **Modern Setup Wizard** at `/setup` (password-protected, beautiful UI)
- **7 Messaging Channels** — Telegram, Discord, Slack, WhatsApp, Feishu/Lark, WeCom, Web
- **12+ AI Providers** — Anthropic, OpenAI, Gemini, OpenRouter, Moonshot, Venice AI, and more
- **Web Search** — Brave Search, Perplexity (direct or via OpenRouter)
- **Persistent Storage** via Railway Volume (config/credentials/memory survive redeploys)
- **Backup & Restore** — One-click export/import for easy migration
- **Debug Console** — Run diagnostics, view logs, restart gateway from the browser
- **Config Editor** — Edit OpenClaw config with auto-backup and live reload
- **Built-in Terminal** — Run OpenClaw CLI commands with autocomplete and history
- **Pairing UI** — Approve DM pairing codes for all channels
- **Bundled Skills** — `agent-browser` (headless Chromium) pre-installed
- **Auto-start Gateway** — Wrapper manages the gateway lifecycle automatically

## Supported channels

| Channel | How it connects | Notes |
|---------|----------------|-------|
| **Telegram** | Bot token from @BotFather | DM pairing support |
| **Discord** | Bot token from Developer Portal | Requires MESSAGE CONTENT INTENT |
| **Slack** | Bot token (`xoxb-`) + App token (`xapp-`) | |
| **WhatsApp** | QR code pairing | No token needed; credentials stored on volume |
| **Feishu / Lark** | App ID + App Secret | WebSocket or Webhook mode; webhook proxy at `/feishu/events` |
| **WeCom** | Corp ID, Agent ID, Token, EncodingAESKey, Secret | |
| **Web** | Auto-enabled after onboarding | Built-in web chat UI |

## Supported AI providers

| Provider | Auth | Notes |
|----------|------|-------|
| **Anthropic** | API key | Claude Opus 4.6 and family |
| **OpenAI** | API key / ChatGPT Codex OAuth | GPT-5.2 and family |
| **Google Gemini** | API key | Gemini 3 Pro, free tier available |
| **OpenRouter** | API key | Access multiple models with one key; free models available |
| **Moonshot AI** | API key | Global, China, and Kimi Code endpoints |
| **Venice AI** | API key | |
| **Vercel AI Gateway** | API key | |
| **Z.AI** | API key | |
| **MiniMax** | API key | M2.1, M2.1 Lightning |
| **Synthetic** | API key | |
| **OpenCode Zen** | API key | |
| **Chutes** | Browser-based auth | |

## What's new in this version

- Updated to OpenClaw 2026.2.6+ with latest auth providers
- **6 new channels** — Slack, WhatsApp, Feishu/Lark, WeCom, and auto-enabled Web chat
- **Web search** — Brave Search, Perplexity integration
- **Pairing UI** — Approve DM access for Telegram, Discord, Web, Feishu, Slack
- **Built-in terminal** with autocomplete and command history (last 50 commands)
- **Agent browser skill** bundled for headless browser automation
- **Config auto-backup** — Timestamped `.bak` created before each save
- Modern, gradient UI with improved UX
- Better error handling and stability
- Enhanced health monitoring
- New providers: Venice AI, Moonshot (CN), MiniMax, Z.AI, OpenCode Zen, Chutes

## How it works

1. **Container runs a wrapper server** — Manages OpenClaw lifecycle and provides the setup UI
2. **Setup wizard** — Protected by `SETUP_PASSWORD`, runs `openclaw onboard` non-interactively
3. **Gateway management** — Automatically starts/restarts the OpenClaw gateway
4. **Reverse proxy** — All traffic (including WebSockets) is proxied to the gateway
5. **Persistent volumes** — Your data survives redeploys via Railway's volume system

## Railway deploy instructions (what you'll publish as a Template)

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

## Getting chat tokens (so you don't have to scramble)

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

### Slack bot tokens
1) Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app
2) Under **OAuth & Permissions**, install the app to your workspace and copy the **Bot Token** (`xoxb-...`)
3) Under **Socket Mode**, enable it and generate an **App-Level Token** (`xapp-...`)
4) Paste both tokens into `/setup`

### WhatsApp
No token needed — `/setup` will show a QR code for you to scan with the WhatsApp app on your phone.

### Feishu / Lark
1) Create an app at [open.feishu.cn](https://open.feishu.cn) (Feishu) or [open.larksuite.com](https://open.larksuite.com) (Lark)
2) Copy **App ID** and **App Secret**
3) Choose WebSocket (recommended) or Webhook mode in `/setup`

### WeCom
1) Go to [work.weixin.qq.com](https://work.weixin.qq.com) and create a self-built app
2) Collect Corp ID, Agent ID, Token, EncodingAESKey, and Secret
3) Paste them into `/setup`

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
- **Anthropic (Recommended)** — Best reliability, uses Claude. Get an API key from [console.anthropic.com](https://console.anthropic.com)
- **OpenAI** — Great alternative, uses GPT-5.2. Get an API key from [platform.openai.com](https://platform.openai.com)

**For advanced users:**
- **OpenRouter** — Access multiple AI models with one API key; has free model options
- **Gemini** — Google's AI models, free tier available
- **Moonshot AI** — Available for both global and China endpoints

### Which messaging channel should I use?

- **Telegram** — Easiest to set up, great for personal use
- **Discord** — Best for community / team use
- **Slack** — Best for workplace integration
- **WhatsApp** — QR pairing, no developer setup needed
- **Feishu / Lark** — For teams using Feishu (China) or Lark (Global)
- **WeCom** — For enterprise WeChat users
- **Web** — Always available after onboarding, no setup required

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
