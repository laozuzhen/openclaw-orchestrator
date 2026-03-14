# OpenClaw Orchestrator Extension

This extension exposes `openclaw-orchestrator` capabilities as tools inside OpenClaw.

Current tool groups:

- Status: `orchestrator_status`
- Monitor: `orchestrator_monitor_statuses`, `orchestrator_live_feed_snapshot`
- Team: `orchestrator_list_teams`, `orchestrator_get_team`, `orchestrator_create_team`, `orchestrator_add_team_member`
- Workflow: `orchestrator_list_workflows`, `orchestrator_get_workflow`, `orchestrator_create_workflow`, `orchestrator_update_workflow`, `orchestrator_execute_workflow`, `orchestrator_list_active_workflows`, `orchestrator_list_workflow_executions`, `orchestrator_stop_workflow`, `orchestrator_get_execution`
- Approval: `orchestrator_list_pending_approvals`, `orchestrator_resolve_approval` (`reject` 会把反馈拼接回原任务并重试上游 task)

## Configuration

`openclaw.plugin.json` and `moltbot.plugin.json` support:

- `baseUrl`: orchestrator service base URL, default `http://127.0.0.1:3721`
- `authToken`: optional bearer token
- `timeoutMs`: HTTP timeout in milliseconds, default `15000`

Environment variables can override them:

- `OPENCLAW_ORCHESTRATOR_BASE_URL`
- `OPENCLAW_ORCHESTRATOR_AUTH_TOKEN`
- `OPENCLAW_ORCHESTRATOR_TIMEOUT_MS`

## Install

The plugin source now lives in the `openclaw-orchestrator` repository instead of the `openclaw` main repository.

From the repository root:

```bash
pnpm install
pnpm plugin:test
pnpm plugin:install
```

`pnpm plugin:install` now defaults to **development mode**:

- automatically writes the repository plugin path into `~/.openclaw/openclaw.json -> plugins.load.paths`
- enables the `openclaw-orchestrator` plugin entry
- writes `baseUrl` / `timeoutMs` into the plugin config when needed
- keeps the plugin pointing at the current repository, so local edits take effect immediately

You can still run the installer directly:

```bash
node scripts/install-openclaw-plugin.mjs
```

### Modes

#### Development mode (default)

```bash
node scripts/install-openclaw-plugin.mjs --mode dev
```

Optional flags:

- `--config <file>`: custom `openclaw.json` path
- `--base-url <url>`: override orchestrator backend URL
- `--auth-token <token>`: write plugin bearer token
- `--timeout-ms <number>`: override HTTP timeout

#### Copy mode

```bash
node scripts/install-openclaw-plugin.mjs --mode copy --force
```

Optional flags:

- `--target <dir>`: custom OpenClaw extensions directory
- `--force`: overwrite an existing copied directory
- all config flags from development mode are also supported

Default copy target:

- Windows: `%USERPROFILE%/.openclaw/extensions/openclaw-orchestrator`
- macOS / Linux: `~/.openclaw/extensions/openclaw-orchestrator`

If your OpenClaw extension loader does not install dependencies automatically, run this once inside the copied plugin directory:

```bash
npm install --omit=dev
```

## Notes

- The extension only bridges tools; it does not bundle the orchestrator frontend or backend.
- Workflow and approval data are still served by the external `openclaw-orchestrator` service.
- Approval rejection is not terminal: `reject` appends feedback to the original task and reruns the nearest upstream task node.
- Agent chat / knowledge / gateway lifecycle tools are intentionally not bridged here; OpenClaw built-in capabilities should be preferred.
