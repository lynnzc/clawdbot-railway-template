// Served at /setup/app.js
// No fancy syntax: keep it maximally compatible.

(function () {
  var statusEl = document.getElementById('status');
  var authGroupEl = document.getElementById('authGroup');
  var authChoiceEl = document.getElementById('authChoice');
  var logEl = document.getElementById('log');

  // Terminal
  var terminalOutEl = document.getElementById('terminalOut');
  var terminalCmdEl = document.getElementById('terminalCmd');
  var terminalRunEl = document.getElementById('terminalRun');
  var terminalClearEl = document.getElementById('terminalClear');
  var terminalSuggestionsEl = document.getElementById('terminalSuggestions');

  // Config editor
  var configPathEl = document.getElementById('configPath');
  var configTextEl = document.getElementById('configText');
  var configReloadEl = document.getElementById('configReload');
  var configSaveEl = document.getElementById('configSave');
  var configOutEl = document.getElementById('configOut');

  // Import
  var importFileEl = document.getElementById('importFile');
  var importRunEl = document.getElementById('importRun');
  var importOutEl = document.getElementById('importOut');

  // Command allowlist for autocomplete
  var COMMANDS = [
    'gateway.restart',
    'gateway.stop',
    'gateway.start',
    'openclaw.version',
    'openclaw.status',
    'openclaw.health',
    'openclaw.doctor',
    'openclaw.channels.status',
    'openclaw.channels.list',
    'openclaw.channels.logs',
    'openclaw.logs',
    'openclaw.config.get',
    'openclaw.config.set',
    'openclaw.config.set.json',
    'openclaw.plugins.list',
    'openclaw.plugins.enable',
    'openclaw.plugins.disable',
    'openclaw.pairing.list',
    'openclaw.pairing.approve'
  ];

  // Command history (session-scoped)
  var historyKey = 'openclaw_terminal_history';
  var cmdHistory = [];
  var historyIndex = -1;
  try {
    var stored = sessionStorage.getItem(historyKey);
    if (stored) cmdHistory = JSON.parse(stored);
  } catch (_e) { /* ignore */ }

  function saveHistory() {
    try {
      // Keep last 50 commands
      var trimmed = cmdHistory.slice(-50);
      sessionStorage.setItem(historyKey, JSON.stringify(trimmed));
    } catch (_e) { /* ignore */ }
  }

  function setStatus(s) {
    statusEl.innerHTML = s;
  }

  function renderAuth(groups) {
    authGroupEl.innerHTML = '';
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      var opt = document.createElement('option');
      opt.value = g.value;
      opt.textContent = g.label + (g.hint ? ' - ' + g.hint : '');
      authGroupEl.appendChild(opt);
    }

    authGroupEl.onchange = function () {
      var sel = null;
      for (var j = 0; j < groups.length; j++) {
        if (groups[j].value === authGroupEl.value) sel = groups[j];
      }
      authChoiceEl.innerHTML = '';
      var opts = (sel && sel.options) ? sel.options : [];
      for (var k = 0; k < opts.length; k++) {
        var o = opts[k];
        var opt2 = document.createElement('option');
        opt2.value = o.value;
        opt2.textContent = o.label + (o.hint ? ' - ' + o.hint : '');
        authChoiceEl.appendChild(opt2);
      }
    };

    authGroupEl.onchange();
  }

  function httpJson(url, opts) {
    opts = opts || {};
    opts.credentials = 'same-origin';
    return fetch(url, opts).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          throw new Error('HTTP ' + res.status + ': ' + (t || res.statusText));
        });
      }
      return res.json();
    });
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // --- Terminal output helpers ---

  function termAppend(html) {
    if (!terminalOutEl) return;
    terminalOutEl.innerHTML += html;
    terminalOutEl.scrollTop = terminalOutEl.scrollHeight;
  }

  function termAppendCmd(cmdText) {
    termAppend('<div class="term-cmd">$ ' + escapeHtml(cmdText) + '</div>');
  }

  function termAppendResult(text, ok) {
    var cls = ok !== false ? 'term-ok' : 'term-err';
    termAppend('<div class="' + cls + '">' + escapeHtml(text) + '</div>');
  }

  // --- Execute a terminal command ---

  function executeCommand(input) {
    if (!input) return;
    input = input.trim();
    if (!input) return;

    // Parse: first token is the command, rest is the arg
    var spaceIdx = input.indexOf(' ');
    var cmd, arg;
    if (spaceIdx === -1) {
      cmd = input;
      arg = '';
    } else {
      cmd = input.slice(0, spaceIdx);
      arg = input.slice(spaceIdx + 1).trim();
    }

    // Normalize: allow shorthand without "openclaw." prefix for non-gateway commands
    if (cmd.indexOf('.') === -1 && cmd !== 'gateway') {
      // Bare words like "health", "status", "logs" etc.
      cmd = 'openclaw.' + cmd;
    }

    // Check if the command is in the allowlist
    if (COMMANDS.indexOf(cmd) === -1) {
      termAppendCmd(input);
      termAppendResult('Unknown command: ' + cmd + '\nAvailable: ' + COMMANDS.join(', '), false);
      return;
    }

    // Add to history
    cmdHistory.push(input);
    historyIndex = -1;
    saveHistory();

    termAppendCmd(input);
    termAppend('<div class="term-ok" style="color:#8b949e">Running...</div>');

    httpJson('/setup/api/console/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: cmd, arg: arg })
    }).then(function (j) {
      // Remove "Running..." line
      if (terminalOutEl) {
        var running = terminalOutEl.querySelector('div:last-child');
        if (running && running.textContent === 'Running...') {
          running.remove();
        }
      }
      termAppendResult(j.output || j.error || '(no output)', j.ok !== false);
    }).catch(function (e) {
      if (terminalOutEl) {
        var running = terminalOutEl.querySelector('div:last-child');
        if (running && running.textContent === 'Running...') {
          running.remove();
        }
      }
      termAppendResult('Error: ' + String(e), false);
    });
  }

  // --- Terminal input handling ---

  if (terminalCmdEl) {
    terminalCmdEl.addEventListener('keydown', function (e) {
      // Enter to run
      if (e.key === 'Enter') {
        e.preventDefault();
        hideSuggestions();
        executeCommand(terminalCmdEl.value);
        terminalCmdEl.value = '';
        return;
      }

      // Up/down for history
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (cmdHistory.length === 0) return;
        if (historyIndex === -1) {
          historyIndex = cmdHistory.length - 1;
        } else if (historyIndex > 0) {
          historyIndex--;
        }
        terminalCmdEl.value = cmdHistory[historyIndex] || '';
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (historyIndex === -1) return;
        if (historyIndex < cmdHistory.length - 1) {
          historyIndex++;
          terminalCmdEl.value = cmdHistory[historyIndex] || '';
        } else {
          historyIndex = -1;
          terminalCmdEl.value = '';
        }
        return;
      }

      // Tab for autocomplete
      if (e.key === 'Tab') {
        e.preventDefault();
        var val = terminalCmdEl.value.trim();
        if (!val) return;
        var matches = getMatches(val);
        if (matches.length === 1) {
          terminalCmdEl.value = matches[0] + ' ';
          hideSuggestions();
        } else if (matches.length > 1) {
          showSuggestions(matches);
        }
        return;
      }

      // Escape to hide suggestions
      if (e.key === 'Escape') {
        hideSuggestions();
        return;
      }
    });

    terminalCmdEl.addEventListener('input', function () {
      var val = terminalCmdEl.value.trim();
      if (val.length > 0 && val.indexOf(' ') === -1) {
        var matches = getMatches(val);
        if (matches.length > 0 && matches.length <= 10) {
          showSuggestions(matches);
        } else {
          hideSuggestions();
        }
      } else {
        hideSuggestions();
      }
    });

    terminalCmdEl.addEventListener('blur', function () {
      // Delay so clicks on suggestions register
      setTimeout(hideSuggestions, 200);
    });
  }

  if (terminalRunEl) {
    terminalRunEl.onclick = function () {
      hideSuggestions();
      executeCommand(terminalCmdEl.value);
      terminalCmdEl.value = '';
      terminalCmdEl.focus();
    };
  }

  if (terminalClearEl) {
    terminalClearEl.onclick = function () {
      if (terminalOutEl) terminalOutEl.innerHTML = '';
    };
  }

  // --- Autocomplete suggestions ---

  function getMatches(prefix) {
    prefix = prefix.toLowerCase();
    var results = [];
    for (var i = 0; i < COMMANDS.length; i++) {
      if (COMMANDS[i].toLowerCase().indexOf(prefix) === 0) {
        results.push(COMMANDS[i]);
      }
    }
    return results;
  }

  var activeSuggestion = -1;

  function showSuggestions(matches) {
    if (!terminalSuggestionsEl) return;
    terminalSuggestionsEl.innerHTML = '';
    activeSuggestion = -1;
    for (var i = 0; i < matches.length; i++) {
      var div = document.createElement('div');
      div.textContent = matches[i];
      div.setAttribute('data-cmd', matches[i]);
      div.onclick = (function (m) {
        return function () {
          terminalCmdEl.value = m + ' ';
          hideSuggestions();
          terminalCmdEl.focus();
        };
      })(matches[i]);
      terminalSuggestionsEl.appendChild(div);
    }
    terminalSuggestionsEl.classList.add('visible');
  }

  function hideSuggestions() {
    if (!terminalSuggestionsEl) return;
    terminalSuggestionsEl.classList.remove('visible');
    activeSuggestion = -1;
  }

  // --- Quick action buttons ---

  var actionButtons = document.querySelectorAll('.terminal-actions button[data-cmd]');
  for (var i = 0; i < actionButtons.length; i++) {
    (function (btn) {
      btn.onclick = function () {
        var cmd = btn.getAttribute('data-cmd');
        var arg = btn.getAttribute('data-arg') || '';
        var needsArg = btn.getAttribute('data-needs-arg');

        if (needsArg) {
          // Populate input and focus for user to type the arg
          terminalCmdEl.value = cmd + ' ';
          terminalCmdEl.focus();
          terminalCmdEl.setSelectionRange(terminalCmdEl.value.length, terminalCmdEl.value.length);
        } else {
          // Execute immediately
          var input = arg ? cmd + ' ' + arg : cmd;
          executeCommand(input);
        }
      };
    })(actionButtons[i]);
  }

  // --- Status, onboarding, config editor, import (unchanged logic) ---

  function refreshStatus() {
    setStatus('<span class="loading"></span> Loading status...');
    return httpJson('/setup/api/status').then(function (j) {
      var ver = j.openclawVersion ? (' | v' + j.openclawVersion) : '';
      var badge = j.configured
        ? '<span class="status-badge configured">Configured</span>'
        : '<span class="status-badge not-configured">Not Configured</span>';
      setStatus(badge + ver);
      renderAuth(j.authGroups || []);

      if (j.channelsAddHelp && j.channelsAddHelp.indexOf('telegram') === -1) {
        logEl.textContent += '\nNote: this openclaw build does not list telegram in `channels add --help`. Telegram auto-add will be skipped.\n';
      }

      if (j.gatewayToken) {
        var link = document.getElementById('openClawLink');
        if (link) link.href = '/openclaw?token=' + encodeURIComponent(j.gatewayToken);
      }

      if (configReloadEl && configTextEl) {
        loadConfigRaw();
      }

    }).catch(function (e) {
      setStatus('Error: ' + String(e));
    });
  }

  document.getElementById('run').onclick = function () {
    var runBtn = document.getElementById('run');
    var originalText = runBtn.textContent;
    runBtn.disabled = true;
    runBtn.innerHTML = '<span class="loading"></span> Running setup...';
    runBtn.style.cursor = 'not-allowed';

    var payload = {
      flow: document.getElementById('flow').value,
      authChoice: authChoiceEl.value,
      authSecret: document.getElementById('authSecret').value,
      telegramToken: document.getElementById('telegramToken').value,
      discordToken: document.getElementById('discordToken').value,
      slackBotToken: document.getElementById('slackBotToken').value,
      slackAppToken: document.getElementById('slackAppToken').value
    };

    logEl.textContent = 'Starting onboarding process...\n\n';

    fetch('/setup/api/run', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (res) {
      return res.text();
    }).then(function (text) {
      var j;
      try { j = JSON.parse(text); } catch (_e) { j = { ok: false, output: text }; }
      logEl.textContent += (j.output || JSON.stringify(j, null, 2));
      if (j.ok) {
        logEl.textContent += '\n[SUCCESS] Setup completed successfully!\n';
      } else {
        logEl.textContent += '\n[ERROR] Setup failed. Please check the output above.\n';
      }
      return refreshStatus();
    }).catch(function (e) {
      logEl.textContent += '\n[ERROR] ' + String(e) + '\n';
    }).finally(function () {
      runBtn.disabled = false;
      runBtn.innerHTML = originalText;
      runBtn.style.cursor = 'pointer';
    });
  };

  // Config raw load/save
  function loadConfigRaw() {
    if (!configTextEl) return;
    if (configOutEl) configOutEl.textContent = '';
    return httpJson('/setup/api/config/raw').then(function (j) {
      if (configPathEl) {
        configPathEl.textContent = 'Config file: ' + (j.path || '(unknown)') + (j.exists ? '' : ' (does not exist yet)');
      }
      configTextEl.value = j.content || '';
    }).catch(function (e) {
      if (configOutEl) configOutEl.textContent = 'Error loading config: ' + String(e);
    });
  }

  function saveConfigRaw() {
    if (!configTextEl) return;
    if (!confirm('Save config and restart gateway? A timestamped .bak backup will be created.')) return;
    if (configOutEl) configOutEl.textContent = 'Saving...\n';
    return httpJson('/setup/api/config/raw', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: configTextEl.value })
    }).then(function (j) {
      if (configOutEl) configOutEl.textContent = 'Saved: ' + (j.path || '') + '\nGateway restarted.\n';
      return refreshStatus();
    }).catch(function (e) {
      if (configOutEl) configOutEl.textContent += '\nError: ' + String(e) + '\n';
    });
  }

  if (configReloadEl) configReloadEl.onclick = loadConfigRaw;
  if (configSaveEl) configSaveEl.onclick = saveConfigRaw;

  // Import backup
  function runImport() {
    if (!importRunEl || !importFileEl) return;
    var f = importFileEl.files && importFileEl.files[0];
    if (!f) {
      alert('Pick a .tar.gz file first');
      return;
    }
    if (!confirm('Import backup? This overwrites files under /data and restarts the gateway.')) return;

    if (importOutEl) importOutEl.textContent = 'Uploading ' + f.name + ' (' + f.size + ' bytes)...\n';

    return f.arrayBuffer().then(function (buf) {
      return fetch('/setup/import', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/gzip' },
        body: buf
      });
    }).then(function (res) {
      return res.text().then(function (t) {
        if (importOutEl) importOutEl.textContent += t + '\n';
        if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + t);
        return refreshStatus();
      });
    }).catch(function (e) {
      if (importOutEl) importOutEl.textContent += '\nError: ' + String(e) + '\n';
    });
  }

  if (importRunEl) importRunEl.onclick = runImport;

  // Pairing approve helper
  var pairingBtn = document.getElementById('pairingApprove');
  if (pairingBtn) {
    pairingBtn.onclick = function () {
      var channel = prompt('Enter channel (telegram or discord):');
      if (!channel) return;
      channel = channel.trim().toLowerCase();
      if (channel !== 'telegram' && channel !== 'discord') {
        alert('Channel must be "telegram" or "discord"');
        return;
      }
      var code = prompt('Enter pairing code (e.g. 3EY4PUYS):');
      if (!code) return;
      logEl.textContent += '\nApproving pairing for ' + channel + '...\n';
      fetch('/setup/api/pairing/approve', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: channel, code: code.trim() })
      }).then(function (r) { return r.text(); })
        .then(function (t) { logEl.textContent += t + '\n'; })
        .catch(function (e) { logEl.textContent += 'Error: ' + String(e) + '\n'; });
    };
  }

  document.getElementById('reset').onclick = function () {
    if (!confirm('Reset setup? This deletes the config file so onboarding can run again.')) return;
    logEl.textContent = 'Resetting...\n';
    fetch('/setup/api/reset', { method: 'POST', credentials: 'same-origin' })
      .then(function (res) { return res.text(); })
      .then(function (t) { logEl.textContent += t + '\n'; return refreshStatus(); })
      .catch(function (e) { logEl.textContent += 'Error: ' + String(e) + '\n'; });
  };

  refreshStatus();
})();
