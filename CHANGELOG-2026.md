# Changelog - OpenClaw Railway Template Redesign (2026)

## Version 2.0.0 - Major Redesign (2026-02-09)

### UI/UX Improvements

- **Completely redesigned `/setup` interface**
  - Modern gradient background with card-based layout
  - Step indicators for better onboarding flow
  - Improved form styling with focus states
  - Loading spinners and better visual feedback
  - Status badges (Configured ✓ / Not Configured ⚠)
  - Clean, professional design
  - Responsive design improvements

- **Enhanced user feedback**
  - Real-time status updates during onboarding
  - Success/error messages with clear text indicators
  - Disabled button states during operations
  - Better error messages and hints

### Technical Updates

- **Updated dependencies**
  - Node.js: 22 → 22.12+ (matching OpenClaw requirements)
  - pnpm: Pinned to 10.23.0 (synced with OpenClaw)
  - Updated base images in Dockerfile

- **Improved stability and performance**
  - Increased gateway ready timeout: 20s → 30s
  - Better health check logic with multiple path fallbacks
  - Enhanced error recovery mechanisms
  - Improved logging throughout the wrapper
  - Auto-restart capability on gateway crashes
  - Request timeout protection (2s per health check)
  - Reduced CPU usage (500ms polling vs 250ms)

- **Enhanced monitoring**
  - `/setup/healthz` now includes detailed metrics
  - Process info, memory usage, and gateway status
  - Better log messages for debugging

### Auth Provider Updates

**New providers added (2026.2.6+ compatibility):**
- Venice AI (privacy-focused)
- Moonshot AI China region (`moonshot-api-key-cn`)
- Chutes (browser automation method)
- Skip option (for manual configuration)

**Updated provider groups:**
- Anthropic moved to top (recommended)
- Better organization and hints
- Updated parameter mappings for all providers
- Support for `setup-token` and `token` flows

**Removed deprecated providers:**
- Cleaned up legacy auth options
- Simplified OAuth flows

### Documentation

- **Comprehensive README updates**
  - Added "What's New" section
  - Visual improvements with emoji
  - New FAQ section covering common questions
  - Better quick-start instructions
  - Updated environment variable documentation

- **Better inline help**
  - Improved tooltips and descriptions
  - Context-specific hints in the UI
  - Better error message formatting

### Bug Fixes

- Fixed gateway starting flag not resetting on error
- Improved race condition handling in startup
- Better cleanup on process exit
- Fixed status display using innerHTML for rich content

### Breaking Changes

**None** - Full backward compatibility maintained:
- Legacy `CLAWDBOT_*` environment variables still work (with warnings)
- Existing deployments can upgrade without data loss
- Config file format unchanged

### Migration Guide

**For existing users:**
1. Simply redeploy - no manual changes needed
2. Your data and config will be preserved
3. Visit `/setup` to see the new UI
4. Consider switching to recommended auth providers

**For new deployments:**
1. Deploy from Railway template
2. Set `SETUP_PASSWORD` environment variable
3. Visit `/setup` and follow the wizard
4. Done!

### Credits

Based on the official [OpenClaw](https://github.com/openclaw/openclaw) project (v2026.2.6+)

Created and maintained by **Vignesh N (@vignesh07)**

### Resources

- OpenClaw Docs: https://docs.openclaw.ai
- GitHub: https://github.com/openclaw/openclaw
- Railway Template: https://railway.com/deploy/clawdbot-railway-template

---

## Previous Versions

See Git history for changes before 2.0.0
