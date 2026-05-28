# pd-helper-cli (Generic Agent Skill Package)

A generic agent skill exported from the pd-helper project; not bound to any specific agent runtime.

## Installed Layout

```
<AGENT_SKILLS>/pd-helper-cli/
├── SKILL.md
├── README.md
├── references/
│   └── methods.md
└── scripts/
    ├── main.mjs
    ├── argv.mjs
    ├── attach.mjs
    ├── codes.mjs
    ├── commands.mjs
    ├── io.mjs
    ├── loop.mjs
    ├── rpc.mjs
    ├── sheet.mjs
    └── transport.mjs
```

`<AGENT_SKILLS>` is the skill directory used by the target agent runtime.

## Install Modes

- **Development (symlink)**: `skill/` contents go into `<AGENT_SKILLS>/pd-helper-cli/`; the repo's `cli/` is symlinked in as `scripts/`, so edits take effect immediately.
- **Release (copy)**: `skill/` contents and `cli/*` are copied into place, with no dependency on the original project path.

## Team Runtime Convention

This skill is generic across agents; the following is the team's default execution convention, not a standard Agent Skill dependency.

- Prefer env `PD_HELPER_CDP` for the CDP endpoint; if unset, open the window for env `PD_HELPER_BIT_ID` via `drive-bitbrowser` and use its returned CDP HTTP endpoint.
- `drive-bitbrowser` skill: https://github.com/favorPotato/drive-bitbrowser
- When installing this skill, confirm `drive-bitbrowser` is available, ask the user for the debug window sequence number (seq), resolve it to a window id, and store it in `PD_HELPER_BIT_ID`.
- The `sheet` command needs env `PD_HELPER_GAS_URL` (Apps Script web app URL) and `PD_HELPER_GAS_TOKEN` (auth token); ask the user for these at install time.

## Run

`node scripts/main.mjs` (any node-compatible runtime may replace `node`)
