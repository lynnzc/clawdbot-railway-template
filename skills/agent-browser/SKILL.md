---
name: agent-browser
description: Headless browser automation CLI optimized for AI agents with accessibility tree snapshots and ref-based element selection
metadata: {"openclaw":{"emoji":"🌐","requires":{"commands":["agent-browser"]},"homepage":"https://github.com/vercel-labs/agent-browser"}}
---

# Agent Browser Skill

Fast browser automation using accessibility tree snapshots with refs for deterministic element selection.

## Core Workflow

```bash
# 1. Navigate and snapshot
agent-browser open https://example.com
agent-browser snapshot -i --json

# 2. Parse refs from JSON, then interact
agent-browser click @e2
agent-browser fill @e3 "text"

# 3. Re-snapshot after page changes
agent-browser snapshot -i --json
```

## Key Commands

### Navigation
```bash
agent-browser open <url>
agent-browser back | forward | reload | close
```

### Snapshot (Always use -i --json)
```bash
agent-browser snapshot -i --json
agent-browser snapshot -i -c -d 5 --json
agent-browser snapshot -s "#main" -i
```

### Interactions (Ref-based)
```bash
agent-browser click @e2
agent-browser fill @e3 "text"
agent-browser type @e3 "text"
agent-browser hover @e4
agent-browser check @e5 | uncheck @e5
agent-browser select @e6 "value"
agent-browser press "Enter"
agent-browser scroll down 500
agent-browser drag @e7 @e8
```

### Get Information
```bash
agent-browser get text @e1 --json
agent-browser get html @e2 --json
agent-browser get value @e3 --json
agent-browser get attr @e4 "href" --json
agent-browser get title --json
agent-browser get url --json
agent-browser get count ".item" --json
```

### Check State
```bash
agent-browser is visible @e2 --json
agent-browser is enabled @e3 --json
agent-browser is checked @e4 --json
```

### Wait
```bash
agent-browser wait @e2
agent-browser wait 1000
agent-browser wait --text "Welcome"
agent-browser wait --url "**/dashboard"
agent-browser wait --load networkidle
agent-browser wait --fn "window.ready === true"
```

### Sessions (Isolated Browsers)
```bash
agent-browser --session admin open site.com
agent-browser --session user open site.com
agent-browser session list
```

### State Persistence
```bash
agent-browser state save auth.json
agent-browser state load auth.json
```

### Screenshots & PDFs
```bash
agent-browser screenshot page.png
agent-browser screenshot --full page.png
agent-browser pdf page.pdf
```

### Network Control
```bash
agent-browser network route "**/ads/*" --abort
agent-browser network route "**/api/*" --body '{"x":1}'
agent-browser network requests --filter api
```

### Cookies & Storage
```bash
agent-browser cookies
agent-browser cookies set name value
agent-browser storage local key
agent-browser storage local set key val
```

### Tabs & Frames
```bash
agent-browser tab new https://example.com
agent-browser tab 2
agent-browser frame @e5
agent-browser frame main
```

## Best Practices

1. **Always use `-i` flag** - Focus on interactive elements
2. **Always use `--json`** - Easier to parse
3. **Wait for stability** - `agent-browser wait --load networkidle`
4. **Save auth state** - Skip login flows with `state save/load`
5. **Use sessions** - Isolate different browser contexts

## Example: Search and Extract

```bash
agent-browser open https://www.google.com
agent-browser snapshot -i --json
agent-browser fill @e1 "AI agents"
agent-browser press Enter
agent-browser wait --load networkidle
agent-browser snapshot -i --json
agent-browser get text @e3 --json
agent-browser get attr @e4 "href" --json
```
