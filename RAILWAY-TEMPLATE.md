# Railway Template Publishing Guide

This document explains how to publish this OpenClaw template to Railway's public template marketplace.

## Method 1: Railway Template Composer (Recommended)

### Step 1: Access Template Composer

1. Log in to https://railway.com
2. Visit https://railway.com/templates/new
   - Or from your Dashboard, click "Publish Template"

### Step 2: Connect GitHub Repository

1. Select your repository: `lynnzc/clawdbot-railway-template`
2. Railway will automatically detect the `railway.toml` configuration
3. Choose the branch: `main`

### Step 3: Configure Services

**Service Name:** `openclaw-gateway`

**Add Volume:**
- Mount Path: `/data`
- Recommended Size: 5-10 GB (users can adjust)

**Enable Public Networking:**
- HTTP port: `8080`
- Generate domain automatically

### Step 4: Configure Environment Variables

Set these variables with appropriate types:

**Required (Generated Secrets):**
```
SETUP_PASSWORD
  Type: Generated Secret
  Description: Password to access /setup wizard. Keep this secure.

OPENCLAW_GATEWAY_TOKEN
  Type: Generated Secret
  Description: Internal token for gateway authentication. Auto-generated.
```

**Recommended (Default Values):**
```
OPENCLAW_STATE_DIR
  Type: Plain Text
  Default: /data/.openclaw
  Description: Directory for OpenClaw state and configuration

OPENCLAW_WORKSPACE_DIR
  Type: Plain Text
  Default: /data/workspace
  Description: Directory for OpenClaw workspace files

OPENCLAW_PUBLIC_PORT
  Type: Plain Text
  Default: 8080
  Description: Port for external access

PORT
  Type: Plain Text
  Default: 8080
  Description: Port the wrapper server listens on
```

**Optional (Advanced):**
```
OPENCLAW_GIT_REF
  Type: Plain Text
  Default: main
  Description: OpenClaw version/branch to build (e.g., main, v2026.2.6)
```

### Step 5: Template Metadata

**Basic Information:**
```
Name: OpenClaw - Personal AI Assistant
Short Description: Deploy your personal AI assistant with multi-channel messaging support in one click
Category: Starter (or AI/ML)
```

**Detailed Description:**
```markdown
Deploy OpenClaw, a powerful personal AI assistant that works across Telegram, Discord, Slack, and more.

Features:
- Modern web-based setup wizard (no CLI required)
- Support for multiple AI providers (Anthropic Claude, OpenAI, Gemini, etc.)
- Multi-channel messaging (Telegram, Discord, Slack)
- Persistent storage with automatic backups
- Built-in debug console and health monitoring
- One-click deployment and updates

This template builds OpenClaw from source and includes a wrapper server that manages the gateway lifecycle automatically.

Perfect for personal use or small teams who want a private AI assistant with full control over their data.
```

**Tags:**
```
ai, chatbot, assistant, telegram, discord, anthropic, openai, claude
```

**Icon/Logo:**
- Upload an icon (512x512 recommended)
- Or use OpenClaw's logo if available

### Step 6: Add README Content

Railway will show your README.md to users. Make sure it includes:
- Quick start instructions
- How to access /setup
- How to get API keys
- How to configure messaging bots
- Link to DEPLOYMENT.md for full guide

### Step 7: Preview and Test

1. Click "Preview Template"
2. Test deploy to your own account
3. Verify:
   - Build completes successfully (5-10 minutes)
   - Health check at /setup/healthz returns OK
   - /setup wizard loads correctly
   - Can complete onboarding flow

### Step 8: Publish

1. Once testing is successful, click "Publish Template"
2. Railway team will review (usually within 24-48 hours)
3. Your template will appear in the marketplace

## Method 2: Using railway.json (Alternative)

If you prefer configuration-as-code, the `railway.json` file has been created with basic settings:

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "DOCKERFILE"
  },
  "deploy": {
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 10,
    "healthcheckPath": "/setup/healthz",
    "healthcheckTimeout": 300
  }
}
```

Note: The Template Composer UI provides more control over environment variables and initial setup.

## Post-Publishing Checklist

After your template is published:

1. **Test the Deploy Button**
   - Deploy from the public template
   - Verify environment variables are set correctly
   - Test the entire onboarding flow

2. **Update Documentation**
   - Add the Railway template badge to README.md
   - Link to the template in documentation
   - Update any relevant blog posts or guides

3. **Monitor Issues**
   - Watch for GitHub issues from users
   - Monitor Railway community feedback
   - Update template based on common issues

4. **Keep Updated**
   - Sync with OpenClaw releases
   - Update Dockerfile when Node.js LTS changes
   - Improve documentation based on user feedback

## Getting the Deploy Button

Once published, Railway will provide you with:

1. **Template URL:**
   ```
   https://railway.com/template/[your-template-id]
   ```

2. **Deploy Button Markdown:**
   ```markdown
   [![Deploy on Railway](https://railway.app/button.svg)](https://railway.com/template/[your-template-id])
   ```

Add this to your README.md at the top.

## Updating Your Template

To update the template after publishing:

1. Push changes to your GitHub repository
2. Railway automatically detects changes
3. Template users will get the updates on their next deployment
4. For breaking changes, update the template description with migration notes

## Support and Resources

- Railway Template Documentation: https://docs.railway.app/deploy/templates
- Railway Template Schema: https://railway.app/railway.schema.json
- Railway Community: https://discord.gg/railway
- OpenClaw Documentation: https://docs.openclaw.ai

## Tips for a Successful Template

1. **Clear Setup Instructions**: Your README should be comprehensive
2. **Default to Secure**: Use generated secrets for sensitive variables
3. **Provide Help**: Link to troubleshooting guides
4. **Test Thoroughly**: Ensure clean deployments every time
5. **Stay Updated**: Keep synced with upstream OpenClaw releases
6. **Be Responsive**: Answer user questions promptly

Good luck with your template publication!
