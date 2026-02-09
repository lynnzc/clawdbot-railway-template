# Deployment Guide - OpenClaw Railway Template

## Quick Deploy to Railway (Recommended)

### Option 1: One-Click Deploy Button

1. Click the "Deploy on Railway" button in the README
2. Railway will fork this repo and create a new project
3. Configure required variables (see below)
4. Deploy automatically

### Option 2: Manual Railway Deployment

1. **Create a new project** on Railway
2. **Connect your GitHub repo** or fork this template
3. **Add a Volume** (required for persistent data):
   - Go to your service → Variables → Add Volume
   - Mount path: `/data`
   - Recommended size: 5-10 GB

4. **Set environment variables**:

   **Required:**
   ```
   SETUP_PASSWORD=your-secure-password-here
   ```

   **Recommended (auto-configured):**
   ```
   OPENCLAW_STATE_DIR=/data/.openclaw
   OPENCLAW_WORKSPACE_DIR=/data/workspace
   OPENCLAW_PUBLIC_PORT=8080
   PORT=8080
   ```

   **Optional:**
   ```
   OPENCLAW_GATEWAY_TOKEN=your-random-token-here
   OPENCLAW_GIT_REF=main
   ```

5. **Enable Public Networking**:
   - Go to Settings → Networking
   - Generate Domain
   - Railway will assign a URL like `your-app.up.railway.app`

6. **Deploy**:
   - Railway will automatically build and deploy
   - Build time: ~5-10 minutes (first deploy)
   - Subsequent deploys: ~2-3 minutes

## Post-Deployment Setup

### 1. Access the Setup Wizard

1. Visit `https://your-app.up.railway.app/setup`
2. Login with your `SETUP_PASSWORD`
3. You'll see the status dashboard

### 2. Choose Your AI Provider

**Recommended for beginners: Anthropic (Claude)**

Get an API key:
1. Visit [console.anthropic.com](https://console.anthropic.com)
2. Create an account
3. Go to "API Keys" → "Create Key"
4. Copy the key (starts with `sk-ant-`)

In the setup wizard:
- Provider group: **Anthropic (Recommended)**
- Auth method: **Anthropic API key**
- Key/Token: Paste your API key
- Wizard flow: **quickstart** (recommended)

**Alternative: OpenAI (GPT-4)**

1. Visit [platform.openai.com](https://platform.openai.com)
2. API Keys → Create new secret key
3. In setup wizard:
   - Provider group: **OpenAI**
   - Auth method: **OpenAI API key**
   - Paste your key

### 3. Configure Messaging Channels (Optional)

#### Telegram Bot

1. Open Telegram, search for **@BotFather**
2. Send `/newbot` and follow prompts
3. Copy the token (format: `123456789:ABC...`)
4. Paste into "Telegram bot token" field in setup

#### Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. New Application → choose a name
3. Bot tab → Add Bot → Copy Token
4. **CRITICAL:** Enable "MESSAGE CONTENT INTENT"
5. OAuth2 → URL Generator:
   - Scopes: `bot`, `applications.commands`
   - Permissions: At least "Send Messages", "Read Message History"
6. Copy the generated URL and invite bot to your server
7. Paste token into "Discord bot token" in setup

#### Slack Bot

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Create New App → From scratch
3. Enable Socket Mode → Generate App-Level Token (connections:write)
4. OAuth & Permissions → Add Bot Token Scopes:
   - `chat:write`, `channels:history`, `im:history`, `im:write`
5. Install to Workspace → Copy Bot Token (`xoxb-...`)
6. In setup wizard:
   - Slack bot token: `xoxb-...`
   - Slack app token: `xapp-...`

### 4. Run Setup

1. Click **🚀 Start Setup** button
2. Wait for onboarding to complete (~30 seconds)
3. Look for "✅ Setup completed successfully!"

### 5. Access OpenClaw

After successful setup:
- Main UI: `https://your-app.up.railway.app/openclaw`
- Gateway API: `https://your-app.up.railway.app/`

## 🔧 Advanced Configuration

### Using the Config Editor

1. Go to `/setup` → "Config editor (advanced)"
2. Click "Reload" to load current config
3. Edit the JSON5 configuration
4. Click "Save" to apply changes (auto-restarts gateway)

### Debug Console

Run diagnostics without SSH:
- `gateway.restart` - Restart the OpenClaw gateway
- `openclaw doctor` - Full health check
- `openclaw status` - View current status
- `openclaw logs --tail 200` - View recent logs
- `openclaw config get <path>` - Get config value

### Backup & Restore

**Export:**
1. Click "Download backup (.tar.gz)" in `/setup`
2. Saves to your computer

**Import:**
1. Use "Import backup" section in `/setup`
2. Select your `.tar.gz` file
3. Click "Import" (restarts gateway)

## 🐛 Troubleshooting

### Build Fails

**Error: pnpm install failed**
- Check Railway build logs
- Ensure you're using the latest version of this template
- Try redeploying

**Error: Out of memory**
- Railway free tier: Increase resources or use a paid plan
- Build requires ~2GB RAM

### Gateway Won't Start

**Check health endpoint:**
```bash
curl https://your-app.up.railway.app/setup/healthz
```

**View logs in Railway:**
1. Go to your service → Deployments
2. Click on latest deployment
3. View logs

**Use debug console:**
1. Visit `/setup`
2. Debug console → Run `openclaw doctor`

### Setup Fails

**"Already configured" message:**
- You've already run setup
- To re-run: Click "Reset Setup" button
- This deletes config file only (keeps credentials)

**Auth errors:**
- Double-check your API key is valid
- Ensure no extra spaces in the key
- Try a different provider

### Can't Access `/setup`

**"Auth required" / 401 error:**
- Check `SETUP_PASSWORD` is set correctly in Railway
- Browser may cache wrong password (try incognito)

**"SETUP_PASSWORD is not set" error:**
- Go to Railway → your service → Variables
- Add `SETUP_PASSWORD` with a strong password
- Redeploy

### Messages Not Working

**Telegram:**
1. Make sure bot token is correct
2. Check pairing mode: Send `/start` to your bot
3. Copy pairing code, use "Approve Pairing" in `/setup`

**Discord:**
1. Verify MESSAGE CONTENT INTENT is enabled
2. Check bot has permissions in your server
3. Try sending a message to test

## 📊 Monitoring

### Health Checks

Railway can monitor your app:

**Endpoint:** `/setup/healthz`

**Example response:**
```json
{
  "ok": true,
  "wrapper": {
    "uptime": 3600,
    "configured": true
  },
  "gateway": {
    "running": true,
    "pid": 42
  }
}
```

### Logs

**View in Railway:**
- Deployments → Select deployment → View Logs

**View in browser:**
- `/setup` → Debug Console → `openclaw logs --tail 200`

## 🔄 Updating OpenClaw

### Update to Latest Version

1. **Option A: Rebuild from main** (recommended)
   - In Railway: Settings → Redeploy
   - Builds latest `main` branch by default

2. **Option B: Pin to specific version**
   - Set env var: `OPENCLAW_GIT_REF=v2026.2.7` (example)
   - Redeploy

### Migration Notes

- Your data persists across updates (stored in `/data` volume)
- Config may need manual adjustment for breaking changes
- Always backup before major updates

## 🆘 Getting Help

1. **Check the FAQ** in README.md
2. **Use the debug console** in `/setup`
3. **Join OpenClaw community:**
   - GitHub Issues: [openclaw/openclaw](https://github.com/openclaw/openclaw/issues)
   - Discord: Check OpenClaw docs for invite link

4. **Railway support:**
   - [Railway Discord](https://discord.gg/railway)
   - [Railway Docs](https://docs.railway.app)

## 🔐 Security Best Practices

1. **Use strong passwords:**
   - `SETUP_PASSWORD`: 16+ characters, random
   - `OPENCLAW_GATEWAY_TOKEN`: Auto-generated or 32+ hex chars

2. **Protect `/setup` endpoint:**
   - Don't share your Railway URL publicly
   - Consider adding Railway's access control

3. **API keys:**
   - Store in Railway environment variables (encrypted)
   - Never commit to git
   - Rotate periodically

4. **Backup regularly:**
   - Download backups monthly
   - Store encrypted offline

## 💰 Cost Estimation

### Railway Costs

**Free tier (Hobby):**
- $5 free credit/month
- Enough for light usage

**Paid (Pro):**
- ~$5-15/month depending on:
  - Runtime hours
  - Volume size (storage)
  - Bandwidth

### AI API Costs

**Anthropic Claude:**
- Claude 3.5 Sonnet: ~$3 per 1M input tokens
- Typical: $5-20/month for personal use

**OpenAI GPT-4:**
- GPT-4 Turbo: ~$10 per 1M input tokens
- Similar range to Anthropic

**Free tiers available:**
- Google Gemini: Free tier available
- OpenRouter: Some free models

## 🎯 Next Steps

After successful deployment:

1. **Test your bot:**
   - Send a message via your configured channel
   - Verify responses

2. **Explore features:**
   - Visit `/openclaw` dashboard
   - Try voice features (if on iOS/macOS)
   - Set up additional channels

3. **Customize:**
   - Edit system prompts in workspace
   - Add custom skills
   - Configure agent behavior

4. **Share:**
   - Invite friends/team to your channels
   - Set up approval workflow for DMs

---

**Need help?** Check the troubleshooting section above or open an issue on GitHub!
