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
      ...process.env,
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
    * { box-sizing: border-box; }
    body {
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
      margin: 0;
      padding: 2rem;
      max-width: 900px;
      background: #1a1a2e;
      min-height: 100vh;
    }
    .container {
      background: white;
      border-radius: 16px;
      padding: 2rem;
      box-shadow: 0 20px 60px rgba(0,0,0,0.5);
    }
    h1 {
      margin-top: 0;
      color: #1a202c;
      font-size: 2rem;
      margin-bottom: 0.5rem;
    }
    .subtitle {
      color: #718096;
      margin-bottom: 2rem;
      font-size: 1rem;
    }
    .card {
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      padding: 1.5rem;
      margin: 1.5rem 0;
      background: #fafafa;
      transition: all 0.3s ease;
    }
    .card:hover {
      box-shadow: 0 4px 12px rgba(0,0,0,0.1);
    }
    .card h2 {
      margin-top: 0;
      color: #2d3748;
      font-size: 1.25rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .step-number {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      background: #0f766e;
      color: white;
      border-radius: 50%;
      font-size: 0.875rem;
      font-weight: 700;
    }
    label {
      display: block;
      margin-top: 1rem;
      font-weight: 600;
      color: #2d3748;
      font-size: 0.875rem;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    input, select {
      width: 100%;
      padding: 0.75rem;
      margin-top: 0.5rem;
      border: 2px solid #e2e8f0;
      border-radius: 8px;
      font-size: 1rem;
      transition: border-color 0.2s ease;
    }
    input:focus, select:focus {
      outline: none;
      border-color: #0d9488;
    }
    button {
      padding: 0.875rem 1.5rem;
      border-radius: 8px;
      border: 0;
      background: #0f766e;
      color: #fff;
      font-weight: 600;
      cursor: pointer;
      font-size: 0.9375rem;
      transition: all 0.2s ease;
      box-shadow: 0 2px 4px rgba(15, 118, 110, 0.3);
    }
    button:hover {
      background: #0d9488;
      transform: translateY(-1px);
      box-shadow: 0 4px 8px rgba(13, 148, 136, 0.4);
    }
    button:active {
      transform: translateY(0);
    }
    code {
      background: #edf2f7;
      padding: 0.25rem 0.5rem;
      border-radius: 4px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.875rem;
    }
    .muted {
      color: #718096;
      font-size: 0.875rem;
      line-height: 1.6;
    }
    .status-badge {
      display: inline-block;
      padding: 0.5rem 1rem;
      border-radius: 6px;
      font-weight: 600;
      font-size: 0.875rem;
    }
    .status-badge.configured {
      background: #c6f6d5;
      color: #22543d;
    }
    .status-badge.not-configured {
      background: #fed7d7;
      color: #742a2a;
    }
    .links {
      margin-top: 1rem;
      padding-top: 1rem;
      border-top: 1px solid #e2e8f0;
    }
    .links a {
      color: #0d9488;
      text-decoration: none;
      font-weight: 500;
    }
    .links a:hover {
      text-decoration: underline;
    }
    pre {
      background: #1a202c;
      color: #e2e8f0;
      padding: 1rem;
      border-radius: 8px;
      overflow-x: auto;
      font-size: 0.875rem;
      line-height: 1.6;
    }
    .btn-secondary {
      background: #4a5568;
    }
    .btn-secondary:hover {
      background: #2d3748;
    }
    .btn-danger {
      background: #e53e3e;
    }
    .btn-danger:hover {
      background: #c53030;
    }
    .terminal-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.375rem;
      margin-bottom: 1rem;
    }
    .terminal-actions button {
      padding: 0.375rem 0.75rem;
      font-size: 0.8125rem;
      border-radius: 999px;
      background: #edf2f7;
      color: #2d3748;
      box-shadow: none;
      font-weight: 500;
    }
    .terminal-actions button:hover {
      background: #0f766e;
      color: #fff;
      transform: none;
      box-shadow: none;
    }
    .terminal-output {
      background: #0d1117;
      color: #c9d1d9;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.8125rem;
      line-height: 1.5;
      padding: 1rem;
      border-radius: 8px 8px 0 0;
      max-height: 400px;
      overflow-y: auto;
      min-height: 120px;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .terminal-output .term-cmd {
      color: #8b949e;
    }
    .terminal-output .term-ok {
      color: #c9d1d9;
    }
    .terminal-output .term-err {
      color: #f85149;
    }
    .terminal-input-row {
      display: flex;
      align-items: center;
      background: #161b22;
      border-radius: 0 0 8px 8px;
      border-top: 1px solid #30363d;
      padding: 0;
    }
    .terminal-prompt {
      color: #58a6ff;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.875rem;
      font-weight: 700;
      padding: 0.625rem 0 0.625rem 0.75rem;
      user-select: none;
    }
    .terminal-input-row input {
      flex: 1;
      background: transparent;
      border: none;
      color: #c9d1d9;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.8125rem;
      padding: 0.625rem 0.5rem;
      margin: 0;
      outline: none;
    }
    .terminal-input-row input::placeholder {
      color: #484f58;
    }
    .terminal-input-row button {
      border-radius: 6px;
      margin: 0.375rem;
      padding: 0.375rem 0.875rem;
      font-size: 0.8125rem;
      background: #238636;
      box-shadow: none;
    }
    .terminal-input-row button:hover {
      background: #2ea043;
      transform: none;
    }
    .terminal-autocomplete {
      position: relative;
    }
    .terminal-suggestions {
      position: absolute;
      bottom: 100%;
      left: 0;
      right: 0;
      background: #1c2128;
      border: 1px solid #30363d;
      border-radius: 6px;
      max-height: 180px;
      overflow-y: auto;
      display: none;
      z-index: 10;
      margin-bottom: 2px;
    }
    .terminal-suggestions.visible {
      display: block;
    }
    .terminal-suggestions div {
      padding: 0.375rem 0.75rem;
      cursor: pointer;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.8125rem;
      color: #c9d1d9;
    }
    .terminal-suggestions div:hover,
    .terminal-suggestions div.active {
      background: #30363d;
    }
    .terminal-clear-row {
      display: flex;
      justify-content: flex-end;
      margin-top: 0.375rem;
    }
    .terminal-clear-row button {
      padding: 0.25rem 0.625rem;
      font-size: 0.75rem;
      background: #4a5568;
      box-shadow: none;
      border-radius: 4px;
    }
    .loading {
      display: inline-block;
      width: 16px;
      height: 16px;
      border: 2px solid #e2e8f0;
      border-top-color: #0d9488;
      border-radius: 50%;
      animation: spin 0.6s linear infinite;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>OpenClaw Setup</h1>
    <p class="subtitle">Configure your personal AI assistant in minutes</p>

  <div id="domainBanner" style="display:none; background:#fffbeb; border:1px solid #f59e0b; border-radius:12px; padding:1rem 1.5rem; margin-bottom:1.5rem;">
    <strong style="color:#92400e;">No public domain detected</strong>
    <p style="color:#78350f; margin:0.5rem 0 0; font-size:0.875rem; line-height:1.6;">
      Your Railway service needs a public domain to be accessible from the internet.<br/>
      Go to Railway Dashboard &rarr; your service &rarr; <strong>Settings</strong> &rarr; <strong>Networking</strong> &rarr;
      <strong>Public Networking</strong> &rarr; click <strong>Generate Domain</strong>.<br/>
      After adding the domain, refresh this page.
    </p>
  </div>

  <div class="card">
    <h2>Status</h2>
    <div id="status">Loading...</div>
    <div style="margin-top: 0.75rem">
      <a id="openClawLink" href="/openclaw" target="_blank">Open OpenClaw UI</a>
      &nbsp;|&nbsp;
      <a href="/setup/export" target="_blank">Download backup (.tar.gz)</a>
    </div>

    <div style="margin-top: 0.75rem">
      <div class="muted" style="margin-bottom:0.25rem"><strong>Import backup</strong> (advanced): restores into <code>/data</code> and restarts the gateway.</div>
      <input id="importFile" type="file" accept=".tar.gz,application/gzip" />
      <button id="importRun" style="background:#7c2d12; margin-top:0.5rem">Import</button>
      <pre id="importOut" style="white-space:pre-wrap"></pre>
    </div>
  </div>

  <div class="card">
    <h2>Terminal</h2>
    <p class="muted">Run OpenClaw CLI commands. Only allowlisted safe commands are permitted.</p>

    <div class="terminal-actions">
      <button data-cmd="gateway.restart">Restart</button>
      <button data-cmd="gateway.stop">Stop</button>
      <button data-cmd="gateway.start">Start</button>
      <button data-cmd="openclaw.health">Health</button>
      <button data-cmd="openclaw.channels.status">Channels</button>
      <button data-cmd="openclaw.plugins.list">Plugins</button>
      <button data-cmd="openclaw.pairing.list">Pairing</button>
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
  </div>

  <div class="card">
    <h2>Config editor (advanced)</h2>
    <p class="muted">Edits the full config file on disk (JSON5). Saving creates a timestamped <code>.bak-*</code> backup and restarts the gateway.</p>
    <div class="muted" id="configPath"></div>
    <textarea id="configText" style="width:100%; height: 260px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;"></textarea>
    <div style="margin-top:0.5rem">
      <button id="configReload" style="background:#1f2937">Reload</button>
      <button id="configSave" style="background:#111; margin-left:0.5rem">Save</button>
    </div>
    <pre id="configOut" style="white-space:pre-wrap"></pre>
  </div>

  <div class="card">
    <h2><span class="step-number">1</span> Model/Auth Provider</h2>
    <p class="muted">Choose your AI model provider and authentication method.</p>
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

    <div id="modelConfigSection" style="display:none; margin-top: 1.5rem; padding: 1rem; border: 1px solid #e2e8f0; border-radius: 8px; background: #f7fafc;">
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
      <input id="modelCustom" placeholder="Or type custom model ID: provider/model-name" style="margin-top: 0.5rem" />
      <div class="muted" style="margin-top: 0.5rem">
        OpenRouter provides 400+ models via one API key. Browse all at
        <a href="https://openrouter.ai/models" target="_blank">openrouter.ai/models</a>.<br/>
        Format: <code>provider/model-name</code>. Custom input overrides dropdown. Leave blank for provider default.
      </div>
    </div>
  </div>

  <div class="card">
    <h2><span class="step-number">2</span> Messaging Channels (Optional)</h2>
    <p class="muted">Connect your messaging platforms now, or add them later from the OpenClaw dashboard.</p>

    <label>Telegram bot token (optional)</label>
    <input id="telegramToken" type="password" placeholder="123456:ABC..." />
    <div class="muted" style="margin-top: 0.25rem">
      Get it from BotFather: open Telegram, message <code>@BotFather</code>, run <code>/newbot</code>, then copy the token.
    </div>

    <label>Discord bot token (optional)</label>
    <input id="discordToken" type="password" placeholder="Bot token" />
    <div class="muted" style="margin-top: 0.25rem">
      Get it from the Discord Developer Portal: create an application, add a Bot, then copy the Bot Token.<br/>
      <strong>Important:</strong> Enable <strong>MESSAGE CONTENT INTENT</strong> in Bot &rarr; Privileged Gateway Intents, or the bot cannot read messages.<br/>
      The bot will respond to DMs and messages in any server it is invited to.
    </div>

    <label>Slack bot token (optional)</label>
    <input id="slackBotToken" type="password" placeholder="xoxb-..." />

    <label>Slack app token (optional)</label>
    <input id="slackAppToken" type="password" placeholder="xapp-..." />

    <hr style="margin: 1.5rem 0; border: none; border-top: 1px solid #e2e8f0;" />

    <label style="display: inline-flex; align-items: center; gap: 0.5rem; text-transform: none; font-size: 1rem;">
      <input id="whatsappEnabled" type="checkbox" style="width: auto; margin: 0;" />
      Enable WhatsApp (QR link pairing)
    </label>
    <div class="muted" style="margin-top: 0.25rem">
      WhatsApp uses QR code pairing via Linked Devices. After setup completes, run
      <code>openclaw.channels.logs whatsapp</code> in the Terminal above to see the QR code,
      then scan it with WhatsApp &rarr; Settings &rarr; Linked Devices &rarr; Link a Device.<br/>
      Credentials are stored under <code>/data/.openclaw/credentials/whatsapp/</code> for future runs.
    </div>

    <hr style="margin: 1.5rem 0; border: none; border-top: 1px solid #e2e8f0;" />

    <label>Feishu / Lark domain</label>
    <select id="feishuDomain" style="width: auto; min-width: 200px;">
      <option value="feishu">Feishu (China)</option>
      <option value="lark">Lark (Global)</option>
    </select>

    <label>Feishu / Lark App ID (optional)</label>
    <input id="feishuAppId" placeholder="cli_xxxxxxxxxx" />
    <div class="muted" style="margin-top: 0.25rem">
      From <a href="https://open.feishu.cn/app" target="_blank">Feishu Open Platform</a> or
      <a href="https://open.larksuite.com/app" target="_blank">Lark Developer</a>:
      create app &rarr; Credentials &amp; Basic Info &rarr; copy App ID and App Secret.<br/>
      Requires plugin <code>@openclaw/feishu</code> (auto-installed).
      See <a href="https://docs.openclaw.ai/channels/feishu" target="_blank">full docs</a>.
    </div>

    <label>Feishu / Lark App Secret (optional)</label>
    <input id="feishuAppSecret" type="password" placeholder="App Secret" />
    <div class="muted" style="margin-top: 0.25rem">
      After setup: configure event subscription in Feishu Open Platform &rarr;
      choose <strong>Use long connection to receive events</strong> (WebSocket) &rarr;
      add event <code>im.message.receive_v1</code>.
    </div>

    <hr style="margin: 1.5rem 0; border: none; border-top: 1px solid #e2e8f0;" />

    <label>WeCom Corp ID (optional)</label>
    <input id="wecomCorpId" placeholder="ww00000000000000" />
    <div class="muted" style="margin-top: 0.25rem">
      From <a href="https://work.weixin.qq.com/wework_admin/frame#apps" target="_blank">WeCom Admin</a>:
      App Management &rarr; create/select agent &rarr; copy Corp ID, Agent ID, Token, and EncodingAESKey.
    </div>

    <label>WeCom Agent ID (optional)</label>
    <input id="wecomAgentId" placeholder="1000002" />

    <label>WeCom Token (optional)</label>
    <input id="wecomToken" type="password" placeholder="Callback token" />

    <label>WeCom EncodingAESKey (optional)</label>
    <input id="wecomEncodingAESKey" type="password" placeholder="43-char AES key" />

    <label>WeCom Secret (optional)</label>
    <input id="wecomSecret" type="password" placeholder="Agent secret" />
  </div>

  <div class="card">
    <h2><span class="step-number">3</span> Run Onboarding</h2>
    <div style="margin-top: 1.5rem; display: flex; gap: 0.75rem; flex-wrap: wrap;">
      <button id="run">Start Setup</button>
      <button id="pairingApprove" class="btn-secondary">Approve Pairing</button>
      <button id="reset" class="btn-danger">Reset Setup</button>
    </div>
    <pre id="log" style="white-space:pre-wrap; margin-top: 1rem;"></pre>
    <p class="muted" style="margin-top: 1rem;">
      <strong>Tip:</strong> Reset deletes the config file to allow re-running setup.
      Pairing approval grants DM access for Telegram/Discord when using pairing mode.
    </p>
  </div>

  </div> <!-- end container -->
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
        ...process.env,
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
      const cfgObj = {
        enabled: true,
        dmPolicy: "pairing",
        ...(isLark ? { domain: "lark" } : {}),
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
      extra += `\n[feishu] Note: you still need to configure event subscription (WebSocket long connection + im.message.receive_v1) in the Feishu/Lark Open Platform.\n`;
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

const ALLOWED_CONSOLE_COMMANDS = new Set([
  // Wrapper-managed lifecycle
  "gateway.restart",
  "gateway.stop",
  "gateway.start",

  // OpenClaw CLI helpers (read-only)
  "openclaw.version",
  "openclaw.status",
  "openclaw.health",
  "openclaw.doctor",
  "openclaw.channels.status",
  "openclaw.channels.list",
  "openclaw.channels.logs",
  "openclaw.logs",
  "openclaw.config.get",

  // Write operations
  "openclaw.config.set",
  "openclaw.config.set.json",
  "openclaw.plugins.list",
  "openclaw.plugins.enable",
  "openclaw.plugins.disable",
  "openclaw.pairing.list",
  "openclaw.pairing.approve",
]);

app.post("/setup/api/console/run", requireSetupAuth, async (req, res) => {
  const payload = req.body || {};
  const cmd = String(payload.cmd || "").trim();
  const arg = String(payload.arg || "").trim();

  if (!ALLOWED_CONSOLE_COMMANDS.has(cmd)) {
    return res.status(400).json({ ok: false, error: "Command not allowed" });
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

    if (cmd === "openclaw.version") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.status") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["status"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.health") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["health"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.doctor") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["doctor"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.channels.status") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "status", "--plain"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.channels.logs") {
      const channel = arg || "all";
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "logs", "--channel", channel, "--lines", "300"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.logs") {
      const limit = Math.max(50, Math.min(1000, Number.parseInt(arg || "200", 10) || 200));
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["logs", "--limit", String(limit), "--plain"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.config.get") {
      if (!arg) return res.status(400).json({ ok: false, error: "Missing config path" });
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", arg]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.config.set") {
      // arg format: "<path> <value>" - split on first space
      const spaceIdx = arg.indexOf(" ");
      if (!arg || spaceIdx < 1) return res.status(400).json({ ok: false, error: "Usage: config.set <path> <value>" });
      const cfgPath = arg.slice(0, spaceIdx);
      const cfgVal = arg.slice(spaceIdx + 1);
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", cfgPath, cfgVal]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) || `Set ${cfgPath}\n` });
    }
    if (cmd === "openclaw.config.set.json") {
      // arg format: "<path> <json>" - split on first space
      const spaceIdx = arg.indexOf(" ");
      if (!arg || spaceIdx < 1) return res.status(400).json({ ok: false, error: "Usage: config.set.json <path> <json>" });
      const cfgPath = arg.slice(0, spaceIdx);
      const cfgVal = arg.slice(spaceIdx + 1);
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", cfgPath, cfgVal]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) || `Set ${cfgPath} (JSON)\n` });
    }
    if (cmd === "openclaw.plugins.list") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["plugins", "list"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.plugins.enable") {
      if (!arg) return res.status(400).json({ ok: false, error: "Usage: plugins.enable <name>" });
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["plugins", "enable", arg]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) || `Enabled plugin: ${arg}\n` });
    }
    if (cmd === "openclaw.plugins.disable") {
      if (!arg) return res.status(400).json({ ok: false, error: "Usage: plugins.disable <name>" });
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["plugins", "disable", arg]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) || `Disabled plugin: ${arg}\n` });
    }
    if (cmd === "openclaw.channels.list") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "list"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.pairing.list") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["pairing", "list"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.pairing.approve") {
      // arg format: "<channel> <code>"
      const spaceIdx = arg.indexOf(" ");
      if (!arg || spaceIdx < 1) return res.status(400).json({ ok: false, error: "Usage: pairing.approve <channel> <code>" });
      const channel = arg.slice(0, spaceIdx);
      const code = arg.slice(spaceIdx + 1).trim();
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["pairing", "approve", channel, code]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }

    return res.status(400).json({ ok: false, error: "Unhandled command" });
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
