---
name: pd-helper-cli
description: Use to collect TikTok / Instagram / NoxInfluencer data, run collection workflows, or manage their tasks (status / logs / cancel) through the pd-helper Chrome extension's bundled CLI.
---

# pd-helper-cli

Run the CLI from the Skill root: `node ./scripts/main.mjs` (any node-compatible runtime may replace `node`).

## Prerequisites

- The target browser has the pd-helper extension installed and enabled.
- CDP endpoint: prefer env `PD_HELPER_CDP`; if unset, the team default is to open the window whose id is env `PD_HELPER_BIT_ID` via `drive-bitbrowser` and pass its returned `http` as `--cdp`.
- Business methods usually require the matching site tab to be open (login and other preconditions: see `references/methods.md`).

## Commands

```sh
node ./scripts/main.mjs call <method> [--param k=v ...]   # start and follow a task to completion
node ./scripts/main.mjs list [--all]                      # list tasks (--all includes terminal ones)
node ./scripts/main.mjs status <taskId>                   # progress snapshot
node ./scripts/main.mjs cancel <taskId>                   # cancel a task
node ./scripts/main.mjs methods                           # list registered methods
node ./scripts/main.mjs sheet <action> [--param k=v ...]  # call an Apps Script action directly
```

Common options: `--cdp <url>`, `--ext-id <id>` (auto-detected by default), `--timeout <seconds>` (default 3600; batch jobs may need a larger value). `--param` only coerces `true` / `false` / `null`; numbers and everything else stay strings (the SW side converts numeric fields itself).

## Rules

- `call` writes strict NDJSON to stdout (one JSON object per line); stderr is human-only, do not parse it.
- Determine the outcome from the final `result` / `error` / `cancelled` frame; on failure read both the process exit code and `data.code`.
- `CAPTCHA` (exit 15): stop retrying; wait and try later, or switch IP / browser environment.
- `RUNTIME_TAB_ERROR` (exit 16): the extension runtime page is unavailable.
- `--param __probe=true`: zero-side-effect check that a business method is registered.
- Troubleshooting: set `PD_HELPER_DEBUG=1` to emit diagnostics to stderr even when it is not a TTY (piped).
- `sheet`: exit 0 on success, exit 1 + stderr on failure; outputs plain JSON, not NDJSON / frames (see the command's usage).

Before calling any business method, read `references/methods.md`: params, tab / login preconditions, execution host, side effects, common failures.
