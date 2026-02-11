import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import express from "express";
import httpProxy from "http-proxy";
import * as tar from "tar";

/** @type {Set<string>} */
const warnedDeprecatedEnv = new Set();

/**
 * Prefer `primaryKey`, fall back to `deprecatedKey` with a one-time warning.
 * @param {string} primaryKey
 * @param {string} deprecatedKey
 */
function getEnvWithShim(primaryKey, deprecatedKey) {
  const primary = process.env[primaryKey]?.trim();
  if (primary) return primary;

  const deprecated = process.env[deprecatedKey]?.trim();
  if (!deprecated) return undefined;

  if (!warnedDeprecatedEnv.has(deprecatedKey)) {
    console.warn(
      `[deprecation] ${deprecatedKey} is deprecated. Use ${primaryKey} instead.`,
    );
    warnedDeprecatedEnv.add(deprecatedKey);
  }

  return deprecated;
}

// Railway deployments sometimes inject PORT=3000 by default. We want the wrapper to
// reliably listen on 8080 unless explicitly overridden.
//
// Prefer OPENCLAW_PUBLIC_PORT (set in the Dockerfile / template) over PORT.
const PORT = Number.parseInt(
  getEnvWithShim("OPENCLAW_PUBLIC_PORT", "CLAWDBOT_PUBLIC_PORT") ??
    process.env.PORT ??
    "8080",
  10,
);

// State/workspace
// On Railway, default to /data volume so config survives redeploys.
// Falls back to ~/.openclaw for local/non-Railway environments.
const isRailway = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);
const STATE_DIR =
  getEnvWithShim("OPENCLAW_STATE_DIR", "CLAWDBOT_STATE_DIR") ||
  (isRailway ? "/data/.openclaw" : path.join(os.homedir(), ".openclaw"));

const WORKSPACE_DIR =
  getEnvWithShim("OPENCLAW_WORKSPACE_DIR", "CLAWDBOT_WORKSPACE_DIR") ||
  (isRailway ? "/data/workspace" : path.join(STATE_DIR, "workspace"));

// Protect /setup with a user-provided password.
const SETUP_PASSWORD = process.env.SETUP_PASSWORD?.trim();

// Gateway admin token (protects OpenClaw gateway + Control UI).
// Must be stable across restarts. If not provided via env, persist it in the state dir.
function resolveGatewayToken() {
  const envTok = getEnvWithShim(
    "OPENCLAW_GATEWAY_TOKEN",
    "CLAWDBOT_GATEWAY_TOKEN",
  );
  if (envTok) return envTok;

  const tokenPath = path.join(STATE_DIR, "gateway.token");
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch {
    // ignore
  }

  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(tokenPath, generated, { encoding: "utf8", mode: 0o600 });
  } catch {
    // best-effort
  }
  return generated;
}

const OPENCLAW_GATEWAY_TOKEN = resolveGatewayToken();
process.env.OPENCLAW_GATEWAY_TOKEN = OPENCLAW_GATEWAY_TOKEN;

// Where the gateway will listen internally (we proxy to it).
const INTERNAL_GATEWAY_PORT = Number.parseInt(process.env.INTERNAL_GATEWAY_PORT ?? "18789", 10);
const INTERNAL_GATEWAY_HOST = process.env.INTERNAL_GATEWAY_HOST ?? "127.0.0.1";
const GATEWAY_TARGET = `http://${INTERNAL_GATEWAY_HOST}:${INTERNAL_GATEWAY_PORT}`;

const FEISHU_WEBHOOK_PORT = Number.parseInt(process.env.FEISHU_WEBHOOK_PORT ?? "3000", 10);
const FEISHU_WEBHOOK_TARGET = `http://127.0.0.1:${FEISHU_WEBHOOK_PORT}`;

// Env vars that only the wrapper needs — strip before spawning gateway/exec
// so the agent's shell environment does not expose them.
const WRAPPER_ONLY_ENV_KEYS = [
  "SETUP_PASSWORD",
];

function gatewayEnv() {
  const env = { ...process.env };
  for (const key of WRAPPER_ONLY_ENV_KEYS) delete env[key];
  return env;
}

// Always run the built-from-source CLI entry directly to avoid PATH/global-install mismatches.
const OPENCLAW_ENTRY = process.env.OPENCLAW_ENTRY?.trim() || "/openclaw/dist/entry.js";
const OPENCLAW_NODE = process.env.OPENCLAW_NODE?.trim() || "node";

function clawArgs(args) {
  return [OPENCLAW_ENTRY, ...args];
}

function configPath() {
  return (
    getEnvWithShim("OPENCLAW_CONFIG_PATH", "CLAWDBOT_CONFIG_PATH") ||
    path.join(STATE_DIR, "openclaw.json")
  );
}

function isConfigured() {
  try {
    return fs.existsSync(configPath());
  } catch {
    return false;
  }
}

let gatewayProc = null;
let gatewayStarting = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForGatewayReady(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30_000; // Increased from 20s to 30s for slower systems
  const start = Date.now();
  let lastError = null;

  while (Date.now() - start < timeoutMs) {
    try {
      // Try the default Control UI base path, then fall back to legacy or root.
      const paths = ["/openclaw", "/clawdbot", "/"];
      for (const p of paths) {
        try {
          const res = await fetch(`${GATEWAY_TARGET}${p}`, {
            method: "GET",
            signal: AbortSignal.timeout(2000) // 2s timeout per request
          });
          // Any HTTP response means the port is open and responsive.
          if (res) {
            console.log(`[wrapper] Gateway ready at ${GATEWAY_TARGET}${p}`);
            return true;
          }
        } catch (err) {
          lastError = err;
          // try next path
        }
      }
    } catch (err) {
      lastError = err;
      // not ready yet
    }
    await sleep(500); // Increased from 250ms to 500ms to reduce CPU usage
  }

  console.error(`[wrapper] Gateway failed to become ready in ${timeoutMs}ms. Last error:`, lastError);
  return false;
}

const BUNDLED_SKILLS_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "skills");

async function startGateway() {
  if (gatewayProc) return;
  if (!isConfigured()) throw new Error("Gateway cannot start: not configured");

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  // Sync config tokens before every start so connectors always match the
  // runtime token, even if the resolved token changed between restarts.
  // We rely on config rather than --token CLI arg to avoid internal mismatches.
  try {
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.mode", "token"]));
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.token", OPENCLAW_GATEWAY_TOKEN]));
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.remote.token", OPENCLAW_GATEWAY_TOKEN]));
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.bind", "loopback"]));
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.port", String(INTERNAL_GATEWAY_PORT)]));
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set.json", "agents.defaults.timeoutSeconds", "600"]));
    // Skip device pairing for Control UI — the wrapper proxy handles auth via SETUP_PASSWORD.
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set.json", "gateway.controlUi.allowInsecureAuth", "true"]));
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "gateway.trustedProxies", '["127.0.0.1"]']));
    // Register bundled skills dir so OpenClaw loads them natively.
    if (fs.existsSync(BUNDLED_SKILLS_DIR)) {
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "skills.load.extraDirs", JSON.stringify([BUNDLED_SKILLS_DIR])]));
    }
    // Exec: allow commands in the container (the container IS the sandbox).
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "tools.exec", JSON.stringify({ host: "sandbox", security: "full" })]));
    // Browser: headless + noSandbox for Docker, use managed profile + system Chromium.
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "browser", JSON.stringify({
      enabled: true, headless: true, noSandbox: true, defaultProfile: "openclaw",
      executablePath: process.env.CHROME_PATH || "/usr/bin/chromium",
    })]));
    // Enable llm-task plugin.
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "plugins.entries.llm-task", JSON.stringify({ enabled: true })]));
  } catch (err) {
    console.error("[wrapper] failed to sync gateway config:", err);
  }

  const args = [
    "gateway",
    "run",
  ];

  gatewayProc = childProcess.spawn(OPENCLAW_NODE, clawArgs(args), {
    stdio: "inherit",
    env: {
      ...gatewayEnv(),
      OPENCLAW_STATE_DIR: STATE_DIR,
      OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
    },
  });

  gatewayProc.on("error", (err) => {
    console.error(`[gateway] spawn error: ${String(err)}`);
    gatewayProc = null;
    gatewayStarting = null;
  });

  gatewayProc.on("exit", (code, signal) => {
    const msg = `[gateway] exited code=${code} signal=${signal}`;
    if (code === 0 || signal === "SIGTERM") {
      console.log(msg + " (expected)");
    } else {
      console.error(msg + " (unexpected - may auto-restart on next request)");
    }
    gatewayProc = null;
    gatewayStarting = null;
  });
}

async function ensureGatewayRunning() {
  if (!isConfigured()) {
    console.log("[wrapper] Gateway cannot start: not configured");
    return { ok: false, reason: "not configured" };
  }
  if (gatewayProc) {
    console.log("[wrapper] Gateway already running (pid: " + gatewayProc.pid + ")");
    return { ok: true };
  }
  if (!gatewayStarting) {
    console.log("[wrapper] Starting gateway...");
    gatewayStarting = (async () => {
      await startGateway();
      const ready = await waitForGatewayReady({ timeoutMs: 30_000 });
      if (!ready) {
        throw new Error("Gateway did not become ready in time");
      }
    })().catch((err) => {
      console.error("[wrapper] Failed to start gateway:", err);
      throw err;
    }).finally(() => {
      gatewayStarting = null;
    });
  }
  await gatewayStarting;
  console.log("[wrapper] Gateway is now ready");
  return { ok: true };
}

async function restartGateway() {
  if (gatewayProc) {
    try {
      gatewayProc.kill("SIGTERM");
    } catch {
      // ignore
    }
    // Give it a moment to exit and release the port.
    await sleep(750);
    gatewayProc = null;
  }
  return ensureGatewayRunning();
}

function requireSetupAuth(req, res, next) {
  if (!SETUP_PASSWORD) {
    return res
      .status(500)
      .type("text/plain")
      .send("SETUP_PASSWORD is not set. Set it in Railway Variables before using /setup.");
  }

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
    return res.status(401).send("Auth required");
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const password = idx >= 0 ? decoded.slice(idx + 1) : "";
  if (password !== SETUP_PASSWORD) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
    return res.status(401).send("Invalid password");
  }
  return next();
}

const app = express();
app.disable("x-powered-by");

// Feishu/Lark webhook: proxy BEFORE body parsing so the raw request stream
// reaches the feishu plugin's HTTP server intact (needed for Lark challenge verification).
const feishuProxy = httpProxy.createProxyServer({ target: FEISHU_WEBHOOK_TARGET, xfwd: true, proxyTimeout: 660_000, timeout: 660_000 });
feishuProxy.on("error", (err, _req, _res) => {
  console.error("[feishu-proxy]", err);
});
app.all("/feishu/events", async (req, res) => {
  if (!isConfigured()) return res.redirect("/setup");
  try {
    await ensureGatewayRunning();
  } catch (err) {
    return res.status(503).type("text/plain").send(`Gateway not ready: ${String(err)}`);
  }
  return feishuProxy.web(req, res);
});

app.use(express.json({ limit: "1mb" }));

// Health endpoint for Railway and monitoring.
app.get("/setup/healthz", (_req, res) => {
  const health = {
    ok: true,
    wrapper: {
      uptime: process.uptime(),
      pid: process.pid,
      memory: process.memoryUsage(),
      configured: isConfigured()
    },
    gateway: {
      running: Boolean(gatewayProc),
      pid: gatewayProc ? gatewayProc.pid : null,
      target: GATEWAY_TARGET
    }
  };
  res.json(health);
});

// Fallback favicon for the OpenClaw chat UI (gateway may not serve one).
// Source: https://github.com/openclaw/openclaw/blob/efc79f6/ui/public/favicon.svg
app.get("/openclaw/favicon.svg", (_req, res) => {
  res.type("image/svg+xml").send(`<svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="lobster-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ff4d4d"/>
      <stop offset="100%" stop-color="#991b1b"/>
    </linearGradient>
  </defs>
  <path d="M60 10 C30 10 15 35 15 55 C15 75 30 95 45 100 L45 110 L55 110 L55 100 C55 100 60 102 65 100 L65 110 L75 110 L75 100 C90 95 105 75 105 55 C105 35 90 10 60 10Z" fill="url(#lobster-gradient)"/>
  <path d="M20 45 C5 40 0 50 5 60 C10 70 20 65 25 55 C28 48 25 45 20 45Z" fill="url(#lobster-gradient)"/>
  <path d="M100 45 C115 40 120 50 115 60 C110 70 100 65 95 55 C92 48 95 45 100 45Z" fill="url(#lobster-gradient)"/>
  <path d="M45 15 Q35 5 30 8" stroke="#ff4d4d" stroke-width="3" stroke-linecap="round"/>
  <path d="M75 15 Q85 5 90 8" stroke="#ff4d4d" stroke-width="3" stroke-linecap="round"/>
  <circle cx="45" cy="35" r="6" fill="#050810"/>
  <circle cx="75" cy="35" r="6" fill="#050810"/>
  <circle cx="46" cy="34" r="2.5" fill="#00e5cc"/>
  <circle cx="76" cy="34" r="2.5" fill="#00e5cc"/>
</svg>`);
});

app.get("/setup/app.js", requireSetupAuth, (_req, res) => {
  // Serve JS for /setup (kept external to avoid inline encoding/template issues)
  res.type("application/javascript");
  res.send(fs.readFileSync(path.join(process.cwd(), "src", "setup-app.js"), "utf8"));
});

app.get("/setup", requireSetupAuth, (_req, res) => {
  // No inline <script>: serve JS from /setup/app.js to avoid any encoding/template-literal issues.
  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenClaw Setup</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f8f8f8;
      color: #111;
      min-height: 100vh;
    }
    .layout {
      display: flex;
      min-height: 100vh;
    }
    .sidebar {
      width: 200px;
      background: #111;
      color: #999;
      padding: 1.5rem 0;
      flex-shrink: 0;
      position: sticky;
      top: 0;
      height: 100vh;
      overflow-y: auto;
    }
    .sidebar-brand {
      padding: 0 1.25rem 1.25rem;
      border-bottom: 1px solid #222;
      margin-bottom: 0.5rem;
    }
    .sidebar-brand h1 {
      font-size: 0.9375rem;
      font-weight: 700;
      color: #fff;
      letter-spacing: -0.01em;
    }
    .sidebar-brand .sidebar-ver {
      font-size: 0.75rem;
      color: #555;
      margin-top: 0.25rem;
    }
    .sidebar-nav a {
      display: block;
      padding: 0.5rem 1.25rem;
      color: #888;
      text-decoration: none;
      font-size: 0.8125rem;
      font-weight: 500;
      border-left: 2px solid transparent;
      transition: color 0.15s, border-color 0.15s;
    }
    .sidebar-nav a:hover {
      color: #ccc;
    }
    .sidebar-nav a.active {
      color: #fff;
      border-left-color: #fff;
    }
    .main {
      flex: 1;
      padding: 2.5rem 3rem;
      max-width: 780px;
    }
    .section {
      display: none;
    }
    .section.active {
      display: block;
    }
    .section-title {
      font-size: 1.125rem;
      font-weight: 700;
      color: #111;
      margin-bottom: 0.25rem;
    }
    .section-desc {
      color: #888;
      font-size: 0.8125rem;
      margin-bottom: 1.5rem;
      line-height: 1.5;
    }
    label {
      display: block;
      margin-top: 1.25rem;
      font-weight: 600;
      color: #333;
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    input, select, textarea {
      width: 100%;
      padding: 0.5rem 0.625rem;
      margin-top: 0.375rem;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 0.875rem;
      font-family: inherit;
      background: #fff;
      color: #111;
      transition: border-color 0.15s;
    }
    input:focus, select:focus, textarea:focus {
      outline: none;
      border-color: #111;
    }
    button {
      padding: 0.5rem 1rem;
      border-radius: 4px;
      border: 1px solid #ddd;
      background: #fff;
      color: #111;
      font-weight: 600;
      cursor: pointer;
      font-size: 0.8125rem;
      transition: background 0.15s, border-color 0.15s;
    }
    button:hover {
      background: #f0f0f0;
      border-color: #bbb;
    }
    .btn-primary {
      background: #111;
      color: #fff;
      border-color: #111;
    }
    .btn-primary:hover {
      background: #333;
      border-color: #333;
    }
    .btn-danger {
      color: #dc2626;
      border-color: #fca5a5;
    }
    .btn-danger:hover {
      background: #fef2f2;
      border-color: #dc2626;
    }
    code {
      background: #f0f0f0;
      padding: 0.125rem 0.375rem;
      border-radius: 3px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.8125rem;
    }
    .muted {
      color: #888;
      font-size: 0.8125rem;
      line-height: 1.6;
    }
    a { color: #111; }
    a:hover { color: #555; }
    .status-badge {
      display: inline-block;
      padding: 0.25rem 0.625rem;
      border-radius: 3px;
      font-weight: 600;
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    .status-badge.configured {
      background: #dcfce7;
      color: #166534;
    }
    .status-badge.not-configured {
      background: #fef2f2;
      color: #991b1b;
    }
    .status-links {
      margin-top: 1rem;
      display: flex;
      gap: 1rem;
      font-size: 0.8125rem;
    }
    .status-links a {
      color: #555;
      text-decoration: none;
      font-weight: 500;
    }
    .status-links a:hover {
      color: #111;
      text-decoration: underline;
    }
    pre {
      background: #111;
      color: #ccc;
      padding: 0.75rem 1rem;
      border-radius: 4px;
      overflow-x: auto;
      font-size: 0.8125rem;
      line-height: 1.6;
      margin: 0.5rem 0 0;
    }
    pre:empty {
      display: none;
    }
    .channel-tabs {
      display: flex;
      gap: 0;
      border-bottom: 1px solid #ddd;
      margin-bottom: 1.25rem;
      overflow-x: auto;
    }
    .channel-tab {
      padding: 0.5rem 0.875rem;
      font-size: 0.8125rem;
      font-weight: 600;
      color: #888;
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      margin-bottom: -1px;
      cursor: pointer;
      border-radius: 0;
      white-space: nowrap;
    }
    .channel-tab:hover { color: #111; background: none; }
    .channel-tab.active { color: #111; border-bottom-color: #111; }
    .channel-panel { display: none; }
    .channel-panel.active { display: block; }
    .terminal-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.25rem;
      margin-bottom: 0.75rem;
    }
    .terminal-actions button {
      padding: 0.25rem 0.625rem;
      font-size: 0.75rem;
      border-radius: 3px;
      background: #f0f0f0;
      color: #555;
      border: 1px solid #e5e5e5;
    }
    .terminal-actions button:hover {
      background: #111;
      color: #fff;
      border-color: #111;
    }
    .terminal-output {
      background: #0d1117;
      color: #c9d1d9;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.75rem;
      line-height: 1.5;
      padding: 0.75rem;
      border-radius: 4px 4px 0 0;
      max-height: 350px;
      overflow-y: auto;
      min-height: 100px;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .terminal-output .term-cmd { color: #8b949e; }
    .terminal-output .term-ok { color: #c9d1d9; }
    .terminal-output .term-err { color: #f85149; }
    .terminal-input-row {
      display: flex;
      align-items: center;
      background: #161b22;
      border-radius: 0 0 4px 4px;
      border-top: 1px solid #30363d;
    }
    .terminal-prompt {
      color: #58a6ff;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.8125rem;
      font-weight: 700;
      padding: 0.5rem 0 0.5rem 0.625rem;
      user-select: none;
    }
    .terminal-input-row input {
      flex: 1;
      background: transparent;
      border: none;
      color: #c9d1d9;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.75rem;
      padding: 0.5rem 0.375rem;
      margin: 0;
      outline: none;
    }
    .terminal-input-row input::placeholder { color: #484f58; }
    .terminal-input-row button {
      border-radius: 3px;
      margin: 0.25rem;
      padding: 0.25rem 0.625rem;
      font-size: 0.75rem;
      background: #238636;
      color: #fff;
      border: none;
    }
    .terminal-input-row button:hover { background: #2ea043; }
    .terminal-autocomplete { position: relative; }
    .terminal-suggestions {
      position: absolute;
      bottom: 100%;
      left: 0; right: 0;
      background: #1c2128;
      border: 1px solid #30363d;
      border-radius: 4px;
      max-height: 160px;
      overflow-y: auto;
      display: none;
      z-index: 10;
      margin-bottom: 2px;
    }
    .terminal-suggestions.visible { display: block; }
    .terminal-suggestions div {
      padding: 0.25rem 0.625rem;
      cursor: pointer;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.75rem;
      color: #c9d1d9;
    }
    .terminal-suggestions div:hover,
    .terminal-suggestions div.active { background: #30363d; }
    .terminal-clear-row {
      display: flex;
      justify-content: flex-end;
      margin-top: 0.25rem;
    }
    .terminal-clear-row button {
      padding: 0.125rem 0.5rem;
      font-size: 0.6875rem;
      background: transparent;
      color: #888;
      border: 1px solid #ddd;
    }
    .field-row {
      display: flex;
      gap: 0.5rem;
      align-items: center;
      flex-wrap: wrap;
      margin-top: 0.75rem;
    }
    .field-row input { max-width: 280px; }
    .loading {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid #ddd;
      border-top-color: #111;
      border-radius: 50%;
      animation: spin 0.6s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (max-width: 768px) {
      .layout { flex-direction: column; }
      .sidebar {
        width: 100%;
        height: auto;
        position: static;
        display: flex;
        flex-wrap: wrap;
        padding: 0.75rem;
        gap: 0;
      }
      .sidebar-brand { border-bottom: none; padding: 0 0.75rem 0.5rem; width: 100%; margin-bottom: 0; }
      .sidebar-nav { display: flex; flex-wrap: wrap; gap: 0; }
      .sidebar-nav a { border-left: none; border-bottom: 2px solid transparent; padding: 0.375rem 0.625rem; font-size: 0.75rem; }
      .sidebar-nav a.active { border-bottom-color: #fff; border-left-color: transparent; }
      .main { padding: 1.25rem; }
    }
  </style>
</head>
<body>
<div class="layout">
  <nav class="sidebar">
    <div class="sidebar-brand">
      <h1>OpenClaw</h1>
      <div class="sidebar-ver" id="sidebarVer"></div>
    </div>
    <div class="sidebar-nav">
      <a href="#" data-nav="status" class="active">Status</a>
      <a href="#" data-nav="terminal">Terminal</a>
      <a href="#" data-nav="config">Config</a>
      <a href="#" data-nav="provider">Provider</a>
      <a href="#" data-nav="websearch">Web Search</a>
      <a href="#" data-nav="channels">Channels</a>
      <a href="#" data-nav="setup">Setup</a>
      <a href="#" data-nav="pairing">Pairing</a>
    </div>
  </nav>

  <main class="main">

  <div id="domainBanner" style="display:none; background:#fffbeb; border:1px solid #e5c96e; border-radius:4px; padding:0.75rem 1rem; margin-bottom:1.5rem; font-size:0.8125rem;">
    <strong>No public domain detected</strong>
    <p style="color:#78350f; margin:0.375rem 0 0; line-height:1.6;">
      Go to Railway Dashboard &rarr; your service &rarr; <strong>Settings</strong> &rarr; <strong>Networking</strong> &rarr;
      <strong>Public Networking</strong> &rarr; <strong>Generate Domain</strong>. Then refresh this page.
    </p>
  </div>

  <!-- Status -->
  <section class="section active" data-section="status">
    <h2 class="section-title">Status</h2>
    <p class="section-desc">Gateway health and quick links.</p>
    <div id="status">Loading...</div>
    <div class="status-links">
      <a id="openClawLink" href="/openclaw" target="_blank">Open UI</a>
      <a href="/setup/export" target="_blank">Export backup</a>
    </div>
    <div style="margin-top: 1.5rem; border-top: 1px solid #eee; padding-top: 1rem;">
      <label style="margin-top:0">Import backup</label>
      <p class="muted" style="margin-bottom: 0.5rem;">Restores into <code>/data</code> and restarts the gateway.</p>
      <input id="importFile" type="file" accept=".tar.gz,application/gzip" />
      <div style="margin-top: 0.5rem;">
        <button id="importRun" class="btn-danger">Import</button>
      </div>
      <pre id="importOut" style="white-space:pre-wrap"></pre>
    </div>
  </section>

  <!-- Terminal -->
  <section class="section" data-section="terminal">
    <h2 class="section-title">Terminal</h2>
    <p class="section-desc">Run OpenClaw CLI commands directly.</p>

    <div class="terminal-actions">
      <button data-cmd="gateway.restart">Restart</button>
      <button data-cmd="gateway.stop">Stop</button>
      <button data-cmd="gateway.start">Start</button>
      <button data-cmd="openclaw.health">Health</button>
      <button data-cmd="openclaw.channels.status">Channels</button>
      <button data-cmd="openclaw.plugins.list">Plugins</button>
      <button data-cmd="openclaw.pairing.list" data-needs-arg="channel (discord, telegram, web, feishu)">Pairing</button>
      <button data-cmd="openclaw.logs" data-arg="200">Logs</button>
      <button data-cmd="openclaw.config.get" data-needs-arg="config path">Config Get</button>
      <button data-cmd="openclaw.config.set" data-needs-arg="path value">Config Set</button>
      <button data-cmd="openclaw.plugins.enable" data-needs-arg="plugin name">Enable Plugin</button>
      <button data-cmd="openclaw.plugins.disable" data-needs-arg="plugin name">Disable Plugin</button>
      <button data-cmd="openclaw.doctor">Doctor</button>
      <button data-cmd="openclaw.version">Version</button>
    </div>

    <div class="terminal-output" id="terminalOut"></div>
    <div class="terminal-autocomplete">
      <div class="terminal-suggestions" id="terminalSuggestions"></div>
      <div class="terminal-input-row">
        <span class="terminal-prompt">$</span>
        <input id="terminalCmd" placeholder="Type command... (e.g. config.get channels)" autocomplete="off" />
        <button id="terminalRun">Run</button>
      </div>
    </div>
    <div class="terminal-clear-row">
      <button id="terminalClear">Clear</button>
    </div>
  </section>

  <!-- Config -->
  <section class="section" data-section="config">
    <h2 class="section-title">Config Editor</h2>
    <p class="section-desc">Edit the full config file (JSON5). Saving creates a backup and restarts the gateway.</p>
    <div class="muted" id="configPath" style="margin-bottom: 0.5rem;"></div>
    <textarea id="configText" style="width:100%; height:280px; font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace; font-size:0.8125rem; border:1px solid #ddd; border-radius:4px; padding:0.75rem;"></textarea>
    <div style="margin-top:0.5rem; display:flex; gap:0.5rem;">
      <button id="configReload">Reload</button>
      <button id="configSave" class="btn-primary">Save</button>
    </div>
    <pre id="configOut" style="white-space:pre-wrap"></pre>
  </section>

  <!-- Provider -->
  <section class="section" data-section="provider">
    <h2 class="section-title">Model / Auth Provider</h2>
    <p class="section-desc">Choose your AI model provider and authentication method.</p>
    <label>Provider group</label>
    <select id="authGroup"></select>

    <label>Auth method</label>
    <select id="authChoice"></select>

    <label>Key / Token (if required)</label>
    <input id="authSecret" type="password" placeholder="Paste API key / token if applicable" />

    <label>Wizard flow</label>
    <select id="flow">
      <option value="quickstart">quickstart</option>
      <option value="advanced">advanced</option>
      <option value="manual">manual</option>
    </select>

    <div id="modelConfigSection" style="display:none; margin-top:1.5rem; padding:1rem; border:1px solid #eee; border-radius:4px; background:#fafafa;">
      <label style="margin-top:0">Model (optional)</label>
      <select id="modelSelect">
        <option value="">Auto (provider default)</option>
        <optgroup label="Anthropic Claude">
          <option value="anthropic/claude-opus-4.6">Claude Opus 4.6</option>
          <option value="anthropic/claude-sonnet-4.5">Claude Sonnet 4.5</option>
          <option value="anthropic/claude-haiku-4.5">Claude Haiku 4.5</option>
        </optgroup>
        <optgroup label="OpenAI">
          <option value="openai/gpt-5.2-codex">GPT-5.2 Codex (400K ctx, Coding)</option>
          <option value="openai/gpt-5.2">GPT-5.2</option>
          <option value="openai/gpt-5-mini">GPT-5 Mini</option>
          <option value="openai/gpt-5-nano">GPT-5 Nano (Budget)</option>
          <option value="openai/o4-mini">o4-mini (Reasoning)</option>
        </optgroup>
        <optgroup label="Google Gemini">
          <option value="google/gemini-3-pro-preview">Gemini 3 Pro Preview</option>
          <option value="google/gemini-3-flash-preview">Gemini 3 Flash Preview</option>
        </optgroup>
        <optgroup label="DeepSeek">
          <option value="deepseek/deepseek-v3.2">DeepSeek V3.2</option>
          <option value="deepseek/deepseek-r1">DeepSeek R1</option>
        </optgroup>
        <optgroup label="Qwen">
          <option value="qwen/qwen3-max-thinking">Qwen3 Max Thinking (262K ctx)</option>
          <option value="qwen/qwen3-coder-next">Qwen3 Coder Next (80B MoE, Coding)</option>
        </optgroup>
        <optgroup label="Moonshot">
          <option value="moonshotai/kimi-k2.5">Kimi K2.5</option>
        </optgroup>
        <optgroup label="ByteDance">
          <option value="bytedance-seed/seed-1.6">Seed 1.6 (256K ctx)</option>
          <option value="bytedance-seed/seed-1.6-flash">Seed 1.6 Flash (Fast)</option>
        </optgroup>
        <optgroup label="Other">
          <option value="minimax/minimax-m2.1">MiniMax M2.1</option>
          <option value="z-ai/glm-4.7-flash">GLM 4.7 Flash</option>
        </optgroup>
        <optgroup label="Free Models">
          <option value="openrouter/free">Free Router (Auto-select)</option>
          <option value="stepfun/step-3.5-flash:free">Step 3.5 Flash (196B MoE)</option>
          <option value="arcee-ai/trinity-large-preview:free">Trinity Large (400B MoE)</option>
        </optgroup>
      </select>
      <input id="modelCustom" placeholder="Or type custom model ID: provider/model-name" style="margin-top:0.5rem" />
      <div class="muted" style="margin-top:0.5rem">
        OpenRouter provides 400+ models via one API key. Browse all at
        <a href="https://openrouter.ai/models" target="_blank">openrouter.ai/models</a>.<br/>
        Format: <code>provider/model-name</code>. Custom input overrides dropdown. Leave blank for provider default.
      </div>
    </div>
  </section>

  <!-- Web Search -->
  <section class="section" data-section="websearch">
    <h2 class="section-title">Web Search</h2>
    <p class="section-desc">Enable web search so the agent can look up real-time information. Keys are stored in config, not environment variables.</p>

    <label>Search Provider</label>
    <select id="webSearchProvider">
      <option value="">Disabled</option>
      <option value="brave">Brave Search</option>
      <option value="perplexity">Perplexity Sonar (via OpenRouter)</option>
      <option value="perplexity-direct">Perplexity Sonar (direct API)</option>
    </select>

    <div id="webSearchBraveFields" style="display:none; margin-top:1rem; padding:1rem; border:1px solid #eee; border-radius:4px; background:#fafafa;">
      <label style="margin-top:0">Brave API Key</label>
      <input id="webSearchBraveKey" type="password" placeholder="BSA..." />
      <div class="muted" style="margin-top:0.25rem">
        Get a free key (2,000 req/month) at
        <a href="https://brave.com/search/api/" target="_blank">brave.com/search/api</a>.
        Choose the <strong>Data for Search</strong> plan (not "Data for AI").
      </div>
    </div>

    <div id="webSearchPerplexityFields" style="display:none; margin-top:1rem; padding:1rem; border:1px solid #eee; border-radius:4px; background:#fafafa;">
      <div class="muted">
        Uses your <strong>OpenRouter API key</strong> from the Provider tab.
        No extra key needed &mdash; Perplexity Sonar calls are billed to your OpenRouter account (~$5/1K queries).
      </div>
      <label style="margin-top:0.75rem">Model</label>
      <select id="webSearchPerplexityModel">
        <option value="perplexity/sonar-pro">Sonar Pro (recommended, multi-step reasoning)</option>
        <option value="perplexity/sonar">Sonar (faster, cheaper)</option>
      </select>
    </div>

    <div id="webSearchPerplexityDirectFields" style="display:none; margin-top:1rem; padding:1rem; border:1px solid #eee; border-radius:4px; background:#fafafa;">
      <label style="margin-top:0">Perplexity API Key</label>
      <input id="webSearchPerplexityKey" type="password" placeholder="pplx-..." />
      <div class="muted" style="margin-top:0.25rem">
        Get a key at <a href="https://www.perplexity.ai/settings/api" target="_blank">perplexity.ai/settings/api</a>.
      </div>
      <label style="margin-top:0.75rem">Model</label>
      <select id="webSearchPerplexityDirectModel">
        <option value="perplexity/sonar-pro">Sonar Pro</option>
        <option value="perplexity/sonar">Sonar</option>
      </select>
    </div>

    <div style="margin-top:1rem;">
      <button id="webSearchSave" class="btn-primary">Save Web Search Config</button>
      <button id="webSearchDisable" class="btn-danger" style="margin-left:0.5rem;">Disable</button>
    </div>
    <pre id="webSearchOut" style="white-space:pre-wrap; margin-top:0.5rem;"></pre>
  </section>

  <!-- Channels -->
  <section class="section" data-section="channels">
    <h2 class="section-title">Messaging Channels</h2>
    <p class="section-desc">Connect messaging platforms. You can add them later from the dashboard too.</p>

    <div class="channel-tabs" id="channelTabs">
      <button class="channel-tab active" data-tab="telegram">Telegram</button>
      <button class="channel-tab" data-tab="discord">Discord</button>
      <button class="channel-tab" data-tab="slack">Slack</button>
      <button class="channel-tab" data-tab="whatsapp">WhatsApp</button>
      <button class="channel-tab" data-tab="feishu">Feishu / Lark</button>
      <button class="channel-tab" data-tab="wecom">WeCom</button>
    </div>

    <div class="channel-panel active" data-panel="telegram">
      <label>Bot Token</label>
      <input id="telegramToken" type="password" placeholder="123456:ABC..." />
      <div class="muted" style="margin-top:0.25rem">
        Get it from BotFather: open Telegram, message <code>@BotFather</code>, run <code>/newbot</code>, then copy the token.
      </div>
    </div>

    <div class="channel-panel" data-panel="discord">
      <label>Bot Token</label>
      <input id="discordToken" type="password" placeholder="Bot token" />
      <div class="muted" style="margin-top:0.25rem">
        From the Discord Developer Portal: create an application, add a Bot, copy the Bot Token.<br/>
        <strong>Important:</strong> Enable <strong>MESSAGE CONTENT INTENT</strong> in Bot &rarr; Privileged Gateway Intents.<br/>
        The bot responds to DMs and messages in any server it joins.
      </div>
    </div>

    <div class="channel-panel" data-panel="slack">
      <label>Bot Token</label>
      <input id="slackBotToken" type="password" placeholder="xoxb-..." />
      <label>App Token</label>
      <input id="slackAppToken" type="password" placeholder="xapp-..." />
    </div>

    <div class="channel-panel" data-panel="whatsapp">
      <label style="display:inline-flex; align-items:center; gap:0.5rem; text-transform:none; font-size:0.875rem;">
        <input id="whatsappEnabled" type="checkbox" style="width:auto; margin:0;" />
        Enable WhatsApp (QR link pairing)
      </label>
      <div class="muted" style="margin-top:0.25rem">
        WhatsApp uses QR code pairing via Linked Devices. After setup, run
        <code>openclaw.channels.logs whatsapp</code> in Terminal to see the QR code,
        then scan it with WhatsApp &rarr; Settings &rarr; Linked Devices &rarr; Link a Device.<br/>
        Credentials are stored under <code>/data/.openclaw/credentials/whatsapp/</code>.
      </div>
    </div>

    <div class="channel-panel" data-panel="feishu">
      <label>Domain</label>
      <select id="feishuDomain" style="width:auto; min-width:200px;">
        <option value="feishu">Feishu (China)</option>
        <option value="lark">Lark (Global)</option>
      </select>

      <label>Connection Mode</label>
      <select id="feishuConnectionMode" style="width:auto; min-width:200px;">
        <option value="websocket">WebSocket (recommended for Feishu China)</option>
        <option value="webhook">Webhook (required for Lark Global)</option>
      </select>

      <label>App ID</label>
      <input id="feishuAppId" placeholder="cli_xxxxxxxxxx" />
      <div class="muted" style="margin-top:0.25rem">
        From <a href="https://open.feishu.cn/app" target="_blank">Feishu Open Platform</a> or
        <a href="https://open.larksuite.com/app" target="_blank">Lark Developer</a>:
        create app &rarr; Credentials &amp; Basic Info &rarr; copy App ID and App Secret.<br/>
        See <a href="https://github.com/m1heng/clawdbot-feishu" target="_blank">full docs</a>.
      </div>

      <label>App Secret</label>
      <input id="feishuAppSecret" type="password" placeholder="App Secret" />

      <div id="feishuWebhookFields" style="display:none">
        <label>Encrypt Key</label>
        <input id="feishuEncryptKey" type="password" placeholder="From Events &amp; Callbacks &rarr; Encryption Strategy" />

        <label>Verification Token</label>
        <input id="feishuVerificationToken" type="password" placeholder="From Events &amp; Callbacks &rarr; Verification Token" />

        <div class="muted" style="margin-top:0.5rem">
          <strong>Webhook mode:</strong> after setup, set Request URL in Lark console to:<br/>
          <code id="feishuWebhookUrl">https://&lt;your-domain&gt;.railway.app/feishu/events</code><br/>
          Then add event <code>im.message.receive_v1</code>.
        </div>
      </div>

      <div id="feishuWsHint" class="muted" style="margin-top:0.25rem">
        <strong>WebSocket mode:</strong> after setup, go to Feishu Open Platform &rarr; Events &amp; Callbacks &rarr;
        choose <strong>Use long connection to receive events</strong> &rarr; add event <code>im.message.receive_v1</code>.
      </div>
    </div>

    <div class="channel-panel" data-panel="wecom">
      <label>Corp ID</label>
      <input id="wecomCorpId" placeholder="ww00000000000000" />
      <div class="muted" style="margin-top:0.25rem">
        From <a href="https://work.weixin.qq.com/wework_admin/frame#apps" target="_blank">WeCom Admin</a>:
        App Management &rarr; create/select agent &rarr; copy Corp ID, Agent ID, Token, and EncodingAESKey.
      </div>

      <label>Agent ID</label>
      <input id="wecomAgentId" placeholder="1000002" />

      <label>Token</label>
      <input id="wecomToken" type="password" placeholder="Callback token" />

      <label>EncodingAESKey</label>
      <input id="wecomEncodingAESKey" type="password" placeholder="43-char AES key" />

      <label>Secret</label>
      <input id="wecomSecret" type="password" placeholder="Agent secret" />
    </div>
  </section>

  <!-- Setup -->
  <section class="section" data-section="setup">
    <h2 class="section-title">Run Onboarding</h2>
    <p class="section-desc">Start the setup wizard to configure your assistant.</p>
    <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
      <button id="run" class="btn-primary">Start Setup</button>
      <button id="reset" class="btn-danger">Reset Setup</button>
    </div>
    <pre id="log" style="white-space:pre-wrap; margin-top:1rem;"></pre>
  </section>

  <!-- Pairing -->
  <section class="section" data-section="pairing">
    <h2 class="section-title">Pairing</h2>
    <p class="section-desc">Approve DM access for channels that use pairing mode.</p>
    <div class="field-row">
      <select id="pairingChannel" style="width:auto; min-width:140px;">
        <option value="discord">Discord</option>
        <option value="telegram">Telegram</option>
        <option value="web">Web</option>
        <option value="feishu">Feishu</option>
        <option value="slack">Slack</option>
      </select>
      <button id="pairingList">List Pending</button>
    </div>
    <pre id="pairingOut" style="white-space:pre-wrap;"></pre>
    <div class="field-row">
      <input id="pairingCode" placeholder="Pairing code (e.g. 3EY4PUYS)" style="max-width:260px;" />
      <button id="pairingApprove" class="btn-primary">Approve</button>
    </div>
  </section>

  </main>
</div>
<script src="/setup/app.js"></script>
</body>
</html>`);
});

app.get("/setup/api/status", requireSetupAuth, async (_req, res) => {
  const version = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
  const channelsHelp = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"]));

  // Updated auth groups based on openclaw 2026.2.6+ (synced with latest onboard options).
  // Ref: openclaw onboard --help and web search for 2026 updates
  const authGroups = [
    { value: "anthropic", label: "Anthropic (Recommended)", hint: "Claude - Most reliable", options: [
      { value: "apiKey", label: "Anthropic API key" },
      { value: "token", label: "Setup token (from console.anthropic.com)" },
      { value: "setup-token", label: "Setup token (alternative)" }
    ]},
    { value: "openai", label: "OpenAI", hint: "ChatGPT / GPT-4", options: [
      { value: "openai-api-key", label: "OpenAI API key" },
      { value: "openai-codex", label: "OpenAI Codex (ChatGPT OAuth)" }
    ]},
    { value: "google", label: "Google", hint: "Gemini", options: [
      { value: "gemini-api-key", label: "Google Gemini API key" }
    ]},
    { value: "openrouter", label: "OpenRouter", hint: "Multi-model proxy", options: [
      { value: "openrouter-api-key", label: "OpenRouter API key" }
    ]},
    { value: "ai-gateway", label: "Vercel AI Gateway", hint: "Multi-model proxy", options: [
      { value: "ai-gateway-api-key", label: "Vercel AI Gateway API key" }
    ]},
    { value: "moonshot", label: "Moonshot AI", hint: "Kimi K2 + Kimi Code", options: [
      { value: "moonshot-api-key", label: "Moonshot AI API key (Global)" },
      { value: "moonshot-api-key-cn", label: "Moonshot AI API key (China)" },
      { value: "kimi-code-api-key", label: "Kimi Code API key" }
    ]},
    { value: "zai", label: "Z.AI", hint: "GLM models", options: [
      { value: "zai-api-key", label: "Z.AI API key" }
    ]},
    { value: "minimax", label: "MiniMax", hint: "Chinese AI models", options: [
      { value: "minimax-api", label: "MiniMax M2.1" },
      { value: "minimax-api-lightning", label: "MiniMax M2.1 Lightning" }
    ]},
    { value: "synthetic", label: "Synthetic", hint: "Anthropic-compatible proxy", options: [
      { value: "synthetic-api-key", label: "Synthetic API key" }
    ]},
    { value: "venice", label: "Venice AI", hint: "Privacy-focused", options: [
      { value: "venice-api-key", label: "Venice AI API key" }
    ]},
    { value: "opencode-zen", label: "OpenCode Zen", hint: "Multi-model proxy", options: [
      { value: "opencode-zen", label: "OpenCode Zen API key" }
    ]},
    { value: "chutes", label: "Chutes", hint: "Browser extension method", options: [
      { value: "chutes", label: "Chutes (browser automation)" }
    ]},
    { value: "skip", label: "Skip (Advanced)", hint: "Configure manually later", options: [
      { value: "skip", label: "Skip authentication setup" }
    ]}
  ];

  const publicDomain = process.env.RAILWAY_PUBLIC_DOMAIN
    || process.env.RAILWAY_STATIC_URL
    || "";

  res.json({
    configured: isConfigured(),
    gatewayTarget: GATEWAY_TARGET,
    gatewayToken: OPENCLAW_GATEWAY_TOKEN,
    openclawVersion: version.output.trim(),
    channelsAddHelp: channelsHelp.output,
    authGroups,
    publicDomain,
    isRailway,
  });
});

function buildOnboardArgs(payload) {
  const args = [
    "onboard",
    "--non-interactive",
    "--accept-risk",
    "--json",
    "--no-install-daemon",
    "--skip-health",
    "--workspace",
    WORKSPACE_DIR,
    // The wrapper owns public networking; keep the gateway internal.
    "--gateway-bind",
    "loopback",
    "--gateway-port",
    String(INTERNAL_GATEWAY_PORT),
    "--gateway-auth",
    "token",
    "--gateway-token",
    OPENCLAW_GATEWAY_TOKEN,
    "--flow",
    payload.flow || "quickstart"
  ];

  if (payload.authChoice) {
    args.push("--auth-choice", payload.authChoice);

    // Map secret to correct flag for common choices (updated for 2026.2.6+).
    const secret = (payload.authSecret || "").trim();
    const map = {
      "openai-api-key": "--openai-api-key",
      "apiKey": "--anthropic-api-key",
      "openrouter-api-key": "--openrouter-api-key",
      "ai-gateway-api-key": "--ai-gateway-api-key",
      "moonshot-api-key": "--moonshot-api-key",
      "moonshot-api-key-cn": "--moonshot-api-key",
      "kimi-code-api-key": "--kimi-code-api-key",
      "gemini-api-key": "--gemini-api-key",
      "zai-api-key": "--zai-api-key",
      "minimax-api": "--minimax-api-key",
      "minimax-api-lightning": "--minimax-api-key",
      "synthetic-api-key": "--synthetic-api-key",
      "venice-api-key": "--venice-api-key",
      "opencode-zen": "--opencode-zen-api-key"
    };
    const flag = map[payload.authChoice];
    if (flag && secret) {
      args.push(flag, secret);
    }

    // Handle token-based auth (setup-token or token with provider)
    if ((payload.authChoice === "token" || payload.authChoice === "setup-token") && secret) {
      args.push("--token-provider", "anthropic", "--token", secret);
    }
  }

  return args;
}

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const proc = childProcess.spawn(cmd, args, {
      ...opts,
      env: {
        ...gatewayEnv(),
        OPENCLAW_STATE_DIR: STATE_DIR,
        OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
      },
    });

    let out = "";
    proc.stdout?.on("data", (d) => (out += d.toString("utf8")));
    proc.stderr?.on("data", (d) => (out += d.toString("utf8")));

    proc.on("error", (err) => {
      out += `\n[spawn error] ${String(err)}\n`;
      resolve({ code: 127, output: out });
    });

    proc.on("close", (code) => resolve({ code: code ?? 0, output: out }));
  });
}

app.post("/setup/api/run", requireSetupAuth, async (req, res) => {
  try {
    if (isConfigured()) {
      await ensureGatewayRunning();
      return res.json({ ok: true, output: "Already configured.\nUse Reset setup if you want to rerun onboarding.\n" });
    }

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  const payload = req.body || {};
  const onboardArgs = buildOnboardArgs(payload);
  const onboard = await runCmd(OPENCLAW_NODE, clawArgs(onboardArgs));

  let extra = "";

  const ok = onboard.code === 0 && isConfigured();

  // Optional channel setup (only after successful onboarding, and only if the installed CLI supports it).
  if (ok) {
    // Ensure gateway token is written into config so the browser UI can authenticate reliably.
    // (We also enforce loopback bind since the wrapper proxies externally.)
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.mode", "token"]));
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.token", OPENCLAW_GATEWAY_TOKEN]));
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.remote.token", OPENCLAW_GATEWAY_TOKEN]));
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.bind", "loopback"]));
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.port", String(INTERNAL_GATEWAY_PORT)]));
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set.json", "agents.defaults.timeoutSeconds", "600"]));

    const channelsHelp = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"]));
    const helpText = channelsHelp.output || "";

    // Match channel names as whole words to avoid false positives
    // (e.g. "web" matching "webhook" in help text).
    const supports = (name) => new RegExp(`\\b${name}\\b`, "i").test(helpText);

    if (payload.telegramToken?.trim()) {
      if (!supports("telegram")) {
        extra += "\n[telegram] skipped (this openclaw build does not list telegram in `channels add --help`)\n";
      } else {
        // Avoid `channels add` here (it has proven flaky across builds); write config directly.
        const token = payload.telegramToken.trim();
        const cfgObj = {
          enabled: true,
          dmPolicy: "pairing",
          botToken: token,
          groupPolicy: "allowlist",
          streamMode: "partial",
        };
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "set", "--json", "channels.telegram", JSON.stringify(cfgObj)]),
        );
        // Enable the plugin in the plugin system (separate from channels.telegram.enabled).
        const enable = await runCmd(OPENCLAW_NODE, clawArgs(["plugins", "enable", "telegram"]));
        const get = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.telegram"]));
        extra += `\n[telegram config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
        extra += `\n[telegram plugin] exit=${enable.code}\n${enable.output || "(no output)"}`;
        extra += `\n[telegram verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`;
      }
    }

    if (payload.discordToken?.trim()) {
      if (!supports("discord")) {
        extra += "\n[discord] skipped (this openclaw build does not list discord in `channels add --help`)\n";
      } else {
        const token = payload.discordToken.trim();
        const cfgObj = {
          enabled: true,
          token,
          // "open" allows the bot to respond in any server it's invited to.
          // Users can tighten this to "allowlist" later and configure specific guilds.
          groupPolicy: "open",
          dm: {
            enabled: true,
            // "pairing" requires users to enter a pairing code before they can DM the bot.
            policy: "pairing",
          },
        };
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "set", "--json", "channels.discord", JSON.stringify(cfgObj)]),
        );
        // Enable the plugin in the plugin system (separate from channels.discord.enabled).
        // Without this, the gateway logs "Discord configured, not enabled yet" and the
        // Discord monitor never starts.
        const enable = await runCmd(OPENCLAW_NODE, clawArgs(["plugins", "enable", "discord"]));
        const get = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.discord"]));
        extra += `\n[discord config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
        extra += `\n[discord plugin] exit=${enable.code}\n${enable.output || "(no output)"}`;
        extra += `\n[discord verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`;
      }
    }

    if (payload.slackBotToken?.trim() || payload.slackAppToken?.trim()) {
      if (!supports("slack")) {
        extra += "\n[slack] skipped (this openclaw build does not list slack in `channels add --help`)\n";
      } else {
        const cfgObj = {
          enabled: true,
          botToken: payload.slackBotToken?.trim() || undefined,
          appToken: payload.slackAppToken?.trim() || undefined,
        };
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "set", "--json", "channels.slack", JSON.stringify(cfgObj)]),
        );
        // Enable the plugin in the plugin system.
        const enable = await runCmd(OPENCLAW_NODE, clawArgs(["plugins", "enable", "slack"]));
        const get = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.slack"]));
        extra += `\n[slack config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
        extra += `\n[slack plugin] exit=${enable.code}\n${enable.output || "(no output)"}`;
        extra += `\n[slack verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`;
      }
    }

    // WhatsApp channel (QR-link pairing — no tokens, just enable the plugin)
    if (payload.whatsappEnabled) {
      if (!supports("whatsapp")) {
        extra += "\n[whatsapp] skipped (this openclaw build does not list whatsapp in `channels add --help`)\n";
      } else {
        const cfgObj = { enabled: true };
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "set", "--json", "channels.whatsapp", JSON.stringify(cfgObj)]),
        );
        const enable = await runCmd(OPENCLAW_NODE, clawArgs(["plugins", "enable", "whatsapp"]));
        extra += `\n[whatsapp config] exit=${set.code}\n${set.output || "(no output)"}`;
        extra += `\n[whatsapp plugin] exit=${enable.code}\n${enable.output || "(no output)"}`;
        extra += `\n[whatsapp] Enabled. After gateway starts, check logs for QR code: run "openclaw.channels.logs whatsapp" in Terminal.\n`;
      }
    }

    // Feishu / Lark channel (plugin pre-installed in Docker image at /openclaw/extensions/feishu)
    if (payload.feishuAppId?.trim() && payload.feishuAppSecret?.trim()) {
      const isLark = payload.feishuDomain === "lark";
      const isWebhook = payload.feishuConnectionMode === "webhook";
      const cfgObj = {
        enabled: true,
        dmPolicy: "pairing",
        ...(isLark ? { domain: "lark" } : {}),
        connectionMode: isWebhook ? "webhook" : "websocket",
        ...(isWebhook ? {
          webhookPort: 3000,
          webhookPath: "/feishu/events",
          ...(payload.feishuEncryptKey?.trim() ? { encryptKey: payload.feishuEncryptKey.trim() } : {}),
          ...(payload.feishuVerificationToken?.trim() ? { verificationToken: payload.feishuVerificationToken.trim() } : {}),
        } : {}),
        accounts: {
          main: {
            appId: payload.feishuAppId.trim(),
            appSecret: payload.feishuAppSecret.trim(),
          },
        },
      };
      const set = await runCmd(
        OPENCLAW_NODE,
        clawArgs(["config", "set", "--json", "channels.feishu", JSON.stringify(cfgObj)]),
      );
      const enable = await runCmd(OPENCLAW_NODE, clawArgs(["plugins", "enable", "feishu"]));
      const get = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.feishu"]));
      extra += `\n[feishu config] exit=${set.code}\n${set.output || "(no output)"}`;
      extra += `\n[feishu plugin] exit=${enable.code}\n${enable.output || "(no output)"}`;
      extra += `\n[feishu verify] exit=${get.code}\n${get.output || "(no output)"}`;
      if (isWebhook) {
        extra += `\n[feishu] Webhook mode enabled on port 3000, path /feishu/events.`;
        extra += `\n[feishu] Set Request URL in Lark console to: https://<your-domain>/feishu/events`;
        extra += `\n[feishu] Add event: im.message.receive_v1\n`;
      } else {
        extra += `\n[feishu] WebSocket mode. Configure event subscription: long connection + im.message.receive_v1\n`;
      }
    }

    // WeCom channel
    if (payload.wecomCorpId?.trim() || payload.wecomToken?.trim()) {
      if (!supports("wecom")) {
        extra += "\n[wecom] skipped (this openclaw build does not list wecom in `channels add --help`)\n";
      } else {
        const cfgObj = {
          enabled: true,
          corpId: payload.wecomCorpId?.trim() || undefined,
          agentId: payload.wecomAgentId?.trim() || undefined,
          token: payload.wecomToken?.trim() || undefined,
          encodingAESKey: payload.wecomEncodingAESKey?.trim() || undefined,
          secret: payload.wecomSecret?.trim() || undefined,
        };
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "set", "--json", "channels.wecom", JSON.stringify(cfgObj)]),
        );
        const enable = await runCmd(OPENCLAW_NODE, clawArgs(["plugins", "enable", "wecom"]));
        const get = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.wecom"]));
        extra += `\n[wecom config] exit=${set.code}\n${set.output || "(no output)"}`;
        extra += `\n[wecom plugin] exit=${enable.code}\n${enable.output || "(no output)"}`;
        extra += `\n[wecom verify] exit=${get.code}\n${get.output || "(no output)"}`;
      }
    }

    // Model configuration (for OpenRouter / multi-model providers)
    // Try known config paths in order; first success wins.
    if (payload.model?.trim()) {
      const m = payload.model.trim();
      const modelPaths = [
        "primaryProvider.largeModel",
        "primaryProvider.smallModel",
        "largeModel",
        "smallModel",
        "primaryProvider.model",
        "provider.largeModel",
        "provider.smallModel",
      ];
      let modelSet = false;
      for (const p of modelPaths) {
        const r = await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", p, m]));
        if (r.code === 0) {
          extra += `\n[model config] Set ${p}=${m}`;
          modelSet = true;
        }
      }
      if (!modelSet) {
        extra += `\n[model config] Could not auto-detect model config path. Set it manually in Config Editor.`;
        extra += `\n  Open the config, find model-related keys, and change them to: ${m}`;
      }
    }

    // Enable the web channel if this build supports it.
    if (supports("web")) {
      const webCfg = { enabled: true, dm: { policy: "open" } };
      const webSet = await runCmd(
        OPENCLAW_NODE,
        clawArgs(["config", "set", "--json", "channels.web", JSON.stringify(webCfg)]),
      );
      const webEnable = await runCmd(OPENCLAW_NODE, clawArgs(["plugins", "enable", "web"]));
      extra += `\n[web config] exit=${webSet.code}\n${webSet.output || "(no output)"}`;
      extra += `\n[web plugin] exit=${webEnable.code}\n${webEnable.output || "(no output)"}`;
    }

    // Register bundled skills (agent-browser, etc.) so they're available immediately.
    if (fs.existsSync(BUNDLED_SKILLS_DIR)) {
      const skillsSet = await runCmd(
        OPENCLAW_NODE,
        clawArgs(["config", "set", "--json", "skills.load.extraDirs", JSON.stringify([BUNDLED_SKILLS_DIR])]),
      );
      extra += `\n[bundled skills] extraDirs=${BUNDLED_SKILLS_DIR}, exit=${skillsSet.code}\n${skillsSet.output || "(no output)"}`;
    }

    // Enable exec (security: full — the container is the sandbox).
    {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "tools.exec", JSON.stringify({ host: "sandbox", security: "full" })]));
      extra += `\n[exec tools] exit=${r.code}\n${r.output || "(no output)"}`;
    }

    // Browser: headless + noSandbox for Docker, use managed "openclaw" profile + system Chromium.
    {
      const browserCfg = {
        enabled: true, headless: true, noSandbox: true, defaultProfile: "openclaw",
        executablePath: process.env.CHROME_PATH || "/usr/bin/chromium",
      };
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "browser", JSON.stringify(browserCfg)]));
      extra += `\n[browser] exit=${r.code}\n${r.output || "(no output)"}`;
    }

    // Enable llm-task plugin.
    {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "plugins.entries.llm-task", JSON.stringify({ enabled: true })]));
      const e = await runCmd(OPENCLAW_NODE, clawArgs(["plugins", "enable", "llm-task"]));
      extra += `\n[llm-task plugin] config=${r.code}, enable=${e.code}\n${e.output || "(no output)"}`;
    }

    // Apply changes immediately.
    await restartGateway();
  }

  return res.status(ok ? 200 : 500).json({
    ok,
    output: redactSecrets(`${onboard.output}${extra}`),
  });
  } catch (err) {
    console.error("[/setup/api/run] error:", err);
    return res.status(500).json({ ok: false, output: `Internal error: ${String(err)}` });
  }
});

// --- Web Search config ---

app.post("/setup/api/websearch", requireSetupAuth, async (req, res) => {
  try {
    const { provider, braveKey, perplexityKey, model } = req.body || {};
    let output = "";

    if (!provider) {
      // Disable web search
      const r = await runCmd(OPENCLAW_NODE, clawArgs([
        "config", "set", "--json", "tools.web.search",
        JSON.stringify({ enabled: false }),
      ]));
      output += `[web search] disabled, exit=${r.code}\n${r.output || ""}`;
    } else if (provider === "brave") {
      if (!braveKey) return res.status(400).json({ ok: false, output: "Brave API key is required." });
      const cfg = { enabled: true, provider: "brave", apiKey: braveKey };
      const r = await runCmd(OPENCLAW_NODE, clawArgs([
        "config", "set", "--json", "tools.web.search", JSON.stringify(cfg),
      ]));
      output += `[web search] brave configured, exit=${r.code}\n${r.output || ""}`;
    } else if (provider === "perplexity") {
      const cfg = {
        enabled: true,
        provider: "perplexity",
        perplexity: {
          baseUrl: "https://openrouter.ai/api/v1",
          model: model || "perplexity/sonar-pro",
        },
      };
      const r = await runCmd(OPENCLAW_NODE, clawArgs([
        "config", "set", "--json", "tools.web.search", JSON.stringify(cfg),
      ]));
      output += `[web search] perplexity via openrouter, exit=${r.code}\n${r.output || ""}`;
    } else if (provider === "perplexity-direct") {
      if (!perplexityKey) return res.status(400).json({ ok: false, output: "Perplexity API key is required." });
      const cfg = {
        enabled: true,
        provider: "perplexity",
        perplexity: {
          apiKey: perplexityKey,
          baseUrl: "https://api.perplexity.ai",
          model: model || "perplexity/sonar-pro",
        },
      };
      const r = await runCmd(OPENCLAW_NODE, clawArgs([
        "config", "set", "--json", "tools.web.search", JSON.stringify(cfg),
      ]));
      output += `[web search] perplexity direct, exit=${r.code}\n${r.output || ""}`;
    } else {
      return res.status(400).json({ ok: false, output: `Unknown provider: ${provider}` });
    }

    if (isConfigured()) await restartGateway();
    res.json({ ok: true, output: redactSecrets(output) });
  } catch (err) {
    console.error("[/setup/api/websearch] error:", err);
    res.status(500).json({ ok: false, output: `Internal error: ${String(err)}` });
  }
});

app.get("/setup/api/websearch", requireSetupAuth, async (_req, res) => {
  try {
    const r = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "tools.web.search"]));
    let config = null;
    try { config = JSON.parse(r.output.trim()); } catch { /* not configured */ }
    res.json({ ok: true, config });
  } catch (err) {
    res.status(500).json({ ok: false, config: null });
  }
});

app.get("/setup/api/debug", requireSetupAuth, async (_req, res) => {
  const v = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
  const help = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"]));
  res.json({
    wrapper: {
      node: process.version,
      port: PORT,
      stateDir: STATE_DIR,
      workspaceDir: WORKSPACE_DIR,
      configPath: configPath(),
      gatewayTokenFromEnv: Boolean(process.env.OPENCLAW_GATEWAY_TOKEN?.trim()),
      gatewayTokenPersisted: fs.existsSync(path.join(STATE_DIR, "gateway.token")),
      railwayCommit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    },
    openclaw: {
      entry: OPENCLAW_ENTRY,
      node: OPENCLAW_NODE,
      version: v.output.trim(),
      channelsAddHelpIncludesTelegram: help.output.includes("telegram"),
    },
  });
});

// --- Debug console (Option A: allowlisted commands + config editor) ---

function redactSecrets(text) {
  if (!text) return text;
  return String(text)
    .replace(/(sk-[A-Za-z0-9_-]{10,})/g, "[REDACTED]")
    .replace(/(sk-or-[A-Za-z0-9_-]{10,})/g, "[REDACTED]")
    .replace(/(gho_[A-Za-z0-9_]{10,})/g, "[REDACTED]")
    .replace(/(xox[baprs]-[A-Za-z0-9-]{10,})/g, "[REDACTED]")
    .replace(/(xapp-[A-Za-z0-9-]{10,})/g, "[REDACTED]")
    .replace(/(AA[A-Za-z0-9_-]{10,}:\S{10,})/g, "[REDACTED]")
    .replace(/(cli_[A-Za-z0-9]{10,})/g, "[REDACTED]")
    .replace(/(EAAG[A-Za-z0-9]{10,})/g, "[REDACTED]")
    // Discord bot tokens: base64UserId.timestamp.hmac
    .replace(/([A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,})/g, "[REDACTED]")
    // Telegram bot tokens: 123456:ABC-xxx
    .replace(/(\d{8,}:[A-Za-z0-9_-]{20,})/g, "[REDACTED]")
    // JSON "appSecret"/"secret"/"token" values
    .replace(/"(appSecret|secret|app_secret|token|botToken|accessToken|encodingAESKey)"\s*:\s*"([^"]{8,})"/gi,
      (_, key) => `"${key}": "[REDACTED]"`);
}

// Any openclaw.* or gateway.* command is accepted and dynamically mapped to CLI args.

app.post("/setup/api/console/run", requireSetupAuth, async (req, res) => {
  const payload = req.body || {};
  const cmd = String(payload.cmd || "").trim();
  const arg = String(payload.arg || "").trim();

  if (!cmd.startsWith("gateway.") && !cmd.startsWith("openclaw.")) {
    return res.status(400).json({ ok: false, error: `Unknown command prefix: ${cmd}. Use openclaw.* or gateway.*` });
  }

  try {
    if (cmd === "gateway.restart") {
      await restartGateway();
      return res.json({ ok: true, output: "Gateway restarted (wrapper-managed).\n" });
    }
    if (cmd === "gateway.stop") {
      if (gatewayProc) {
        try { gatewayProc.kill("SIGTERM"); } catch {}
        await sleep(750);
        gatewayProc = null;
      }
      return res.json({ ok: true, output: "Gateway stopped (wrapper-managed).\n" });
    }
    if (cmd === "gateway.start") {
      const r = await ensureGatewayRunning();
      return res.json({ ok: Boolean(r.ok), output: r.ok ? "Gateway started.\n" : `Gateway not started: ${r.reason}\n` });
    }

    // Dynamic openclaw.* → CLI mapping
    // "openclaw.version"           → openclaw --version
    // "openclaw.config.set.json x" → openclaw config set --json x
    // "openclaw.devices.list"      → openclaw devices list
    if (cmd.startsWith("openclaw.")) {
      const sub = cmd.slice("openclaw.".length);

      // Special: version → --version
      if (sub === "version") {
        const r = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
        return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
      }

      // Special: config.set.json → config set --json <path> <json>
      if (sub === "config.set.json") {
        const spaceIdx = arg.indexOf(" ");
        if (!arg || spaceIdx < 1) return res.status(400).json({ ok: false, error: "Usage: config.set.json <path> <json>" });
        const cfgPath = arg.slice(0, spaceIdx);
        const cfgVal = arg.slice(spaceIdx + 1);
        const r = await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", cfgPath, cfgVal]));
        return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) || `Set ${cfgPath} (JSON)\n` });
      }

      // Generic: split dots into CLI subcommands, append arg tokens
      const cliArgs = sub.split(".");
      if (arg) cliArgs.push(...arg.split(/\s+/));
      const r = await runCmd(OPENCLAW_NODE, clawArgs(cliArgs));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }

    return res.status(400).json({ ok: false, error: `Unknown command: ${cmd}` });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

app.get("/setup/api/config/raw", requireSetupAuth, async (_req, res) => {
  try {
    const p = configPath();
    const exists = fs.existsSync(p);
    const content = exists ? fs.readFileSync(p, "utf8") : "";
    res.json({ ok: true, path: p, exists, content });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.post("/setup/api/config/raw", requireSetupAuth, async (req, res) => {
  try {
    const content = String((req.body && req.body.content) || "");
    if (content.length > 500_000) {
      return res.status(413).json({ ok: false, error: "Config too large" });
    }

    fs.mkdirSync(STATE_DIR, { recursive: true });

    const p = configPath();
    // Backup
    if (fs.existsSync(p)) {
      const backupPath = `${p}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      fs.copyFileSync(p, backupPath);
    }

    fs.writeFileSync(p, content, { encoding: "utf8", mode: 0o600 });

    // Apply immediately.
    if (isConfigured()) {
      await restartGateway();
    }

    res.json({ ok: true, path: p });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.post("/setup/api/pairing/approve", requireSetupAuth, async (req, res) => {
  const { channel, code } = req.body || {};
  if (!channel || !code) {
    return res.status(400).json({ ok: false, error: "Missing channel or code" });
  }
  const r = await runCmd(OPENCLAW_NODE, clawArgs(["pairing", "approve", String(channel), String(code)]));
  return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: r.output });
});

app.post("/setup/api/reset", requireSetupAuth, async (_req, res) => {
  // Minimal reset: delete the config file so /setup can rerun.
  // Keep credentials/sessions/workspace by default.
  try {
    fs.rmSync(configPath(), { force: true });
    res.type("text/plain").send("OK - deleted config file. You can rerun setup now.");
  } catch (err) {
    res.status(500).type("text/plain").send(String(err));
  }
});

app.get("/setup/export", requireSetupAuth, async (_req, res) => {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  res.setHeader("content-type", "application/gzip");
  res.setHeader(
    "content-disposition",
    `attachment; filename="openclaw-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz"`,
  );

  // Prefer exporting from a common /data root so archives are easy to inspect and restore.
  // This preserves dotfiles like /data/.openclaw/openclaw.json.
  const stateAbs = path.resolve(STATE_DIR);
  const workspaceAbs = path.resolve(WORKSPACE_DIR);

  const dataRoot = "/data";
  const underData = (p) => p === dataRoot || p.startsWith(dataRoot + path.sep);

  let cwd = "/";
  let paths = [stateAbs, workspaceAbs].map((p) => p.replace(/^\//, ""));

  if (underData(stateAbs) && underData(workspaceAbs)) {
    cwd = dataRoot;
    // We export relative to /data so the archive contains: .openclaw/... and workspace/...
    paths = [
      path.relative(dataRoot, stateAbs) || ".",
      path.relative(dataRoot, workspaceAbs) || ".",
    ];
  }

  const stream = tar.c(
    {
      gzip: true,
      portable: true,
      noMtime: true,
      cwd,
      onwarn: () => {},
    },
    paths,
  );

  stream.on("error", (err) => {
    console.error("[export]", err);
    if (!res.headersSent) res.status(500);
    res.end(String(err));
  });

  stream.pipe(res);
});

function isUnderDir(p, root) {
  const abs = path.resolve(p);
  const r = path.resolve(root);
  return abs === r || abs.startsWith(r + path.sep);
}

function looksSafeTarPath(p) {
  if (!p) return false;
  // tar paths always use / separators
  if (p.startsWith("/") || p.startsWith("\\")) return false;
  // windows drive letters
  if (/^[A-Za-z]:[\\/]/.test(p)) return false;
  // path traversal
  if (p.split("/").includes("..")) return false;
  return true;
}

async function readBodyBuffer(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Import a backup created by /setup/export.
// This is intentionally limited to restoring into /data to avoid overwriting arbitrary host paths.
app.post("/setup/import", requireSetupAuth, async (req, res) => {
  try {
    const dataRoot = "/data";
    if (!isUnderDir(STATE_DIR, dataRoot) || !isUnderDir(WORKSPACE_DIR, dataRoot)) {
      return res
        .status(400)
        .type("text/plain")
        .send("Import is only supported when OPENCLAW_STATE_DIR and OPENCLAW_WORKSPACE_DIR are under /data (Railway volume).\n");
    }

    // Stop gateway before restore so we don't overwrite live files.
    if (gatewayProc) {
      try { gatewayProc.kill("SIGTERM"); } catch {}
      await sleep(750);
      gatewayProc = null;
    }

    const buf = await readBodyBuffer(req, 250 * 1024 * 1024); // 250MB max
    if (!buf.length) return res.status(400).type("text/plain").send("Empty body\n");

    // Extract into /data.
    // We only allow safe relative paths, and we intentionally do NOT delete existing files.
    // (Users can reset/redeploy or manually clean the volume if desired.)
    const tmpPath = path.join(os.tmpdir(), `openclaw-import-${Date.now()}.tar.gz`);
    fs.writeFileSync(tmpPath, buf);

    await tar.x({
      file: tmpPath,
      cwd: dataRoot,
      gzip: true,
      strict: true,
      onwarn: () => {},
      filter: (p) => {
        // Allow only paths that look safe.
        return looksSafeTarPath(p);
      },
    });

    try { fs.rmSync(tmpPath, { force: true }); } catch {}

    // Restart gateway after restore.
    if (isConfigured()) {
      await restartGateway();
    }

    res.type("text/plain").send("OK - imported backup into /data and restarted gateway.\n");
  } catch (err) {
    console.error("[import]", err);
    res.status(500).type("text/plain").send(String(err));
  }
});

// Proxy everything else to the gateway.
const proxy = httpProxy.createProxyServer({
  target: GATEWAY_TARGET,
  ws: true,
  xfwd: true,
  proxyTimeout: 660_000,
  timeout: 660_000,
});

proxy.on("error", (err, _req, _res) => {
  console.error("[proxy]", err);
});

app.use(async (req, res) => {
  // If not configured, force users to /setup for any non-setup routes.
  if (!isConfigured() && !req.path.startsWith("/setup")) {
    return res.redirect("/setup");
  }

  if (isConfigured()) {
    try {
      await ensureGatewayRunning();
    } catch (err) {
      return res.status(503).type("text/plain").send(`Gateway not ready: ${String(err)}`);
    }
  }

  return proxy.web(req, res, { target: GATEWAY_TARGET });
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`[wrapper] listening on :${PORT}`);
  console.log(`[wrapper] state dir: ${STATE_DIR}`);
  console.log(`[wrapper] workspace dir: ${WORKSPACE_DIR}`);
  console.log(`[wrapper] gateway token: ${OPENCLAW_GATEWAY_TOKEN ? "(set)" : "(missing)"}`);
  console.log(`[wrapper] gateway target: ${GATEWAY_TARGET}`);
  if (!SETUP_PASSWORD) {
    console.warn("[wrapper] WARNING: SETUP_PASSWORD is not set; /setup will error.");
  }
  if (isRailway && !process.env.RAILWAY_PUBLIC_DOMAIN && !process.env.RAILWAY_STATIC_URL) {
    console.warn("[wrapper] WARNING: No public domain detected on Railway.");
    console.warn("[wrapper] Go to Railway Dashboard → Settings → Networking → Public Networking → Generate Domain");
  }
  // Don't start gateway unless configured; proxy will ensure it starts.
});

server.on("upgrade", async (req, socket, head) => {
  if (!isConfigured()) {
    socket.destroy();
    return;
  }
  try {
    await ensureGatewayRunning();
  } catch {
    socket.destroy();
    return;
  }
  proxy.ws(req, socket, head, { target: GATEWAY_TARGET });
});

process.on("SIGTERM", () => {
  // Best-effort shutdown
  try {
    if (gatewayProc) gatewayProc.kill("SIGTERM");
  } catch {
    // ignore
  }
  process.exit(0);
});
