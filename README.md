# Forge — Editor-native coding agent built on TrueForge

> Forked from [cline/cline](https://github.com/cline/cline) at commit `eff43e19b267e171f597ab03733bfed25090f72d` (`main`, 2026-11-17).
> Upstream LICENSE (Apache-2.0) is preserved unchanged in [`LICENSE`](./LICENSE).
> TrueFoundry Forge-a-thon submission · 2026.

**The fork point commit is the first commit on branch `forge`. Everything after that
is the delta judges evaluate.**

## What this is

Forge is the Cline VS Code extension with the agent loop replaced by
[TrueForge](https://github.com/truefoundry/trueforge). TrueForge handles sessions,
turns, approvals, streaming, subagents, deferred tool loading and compaction.
The extension handles everything else the agent needs from the editor — reading
files, searching the workspace, showing diffs, applying accepted hunks.

The agent definition used by this extension lives at
[`.trueforge/agents/forge-editor.json`](./.trueforge/agents/forge-editor.json).

## Setup (from clean clone)

**Prerequisites:** macOS or Linux, Node ≥ 22, Bun 1.4.2, Python 3.11+ (only for the
Flask demo repository), VS Code ≥ 1.96, git.

```bash
git clone https://github.com/Mohak-Singhal/forge.git && cd forge
bun install
bun run build:sdk            # SDK packages resolve via compiled dist/
cd apps/vscode
bun run package              # check-types + lint + production build; writes dist/extension.js
cd ..
```

### 1. Start TrueForge (local mode, never deployed)

```bash
OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]' npx @truefoundry/trueforge@latest
```

Plain `npx @truefoundry/trueforge@latest` also works, but then TrueForge blocks the
loopback connection to the extension's MCP server — the extension logs the failure and
the agent surfaces a clear error. The loopback allowlist is required for the editor
tools to reach the agent.

TrueForge listens on `http://localhost:8790`. Open `http://localhost:8790/settings/models`
and register a provider — a gateway, a free tier, or a model running locally behind an
OpenAI-compatible endpoint. See [`.trueforge/models.example.json`](./.trueforge/models.example.json)
for importable examples (Ollama, and a generic OpenAI-compatible entry with a primary and
a fallback model). **The extension never calls a model provider directly; all model
traffic goes through TrueForge.** Keys live only in the TrueForge server's config —
never in this repository.

For the reference development run, we used a custom OpenAI-compatible provider
(`opencode-free-models`, free gateway) with two models: `deepseek-v41-flash-free`
(primary) and `qwen-coder-local` (fallback, Ollama `qwen2.5-coder:1.5b` on
`127.0.0.1:11434`). These are exactly the names in
[`.trueforge/agents/forge-editor.json`](./.trueforge/agents/forge-editor.json).
Approximate cost: $0.

### 2. Load the extension and point it at a workspace

```bash
code --extensionDevelopmentPath="$PWD/apps/vscode" <path-to-workspace>
```

On activation the extension:

1. starts the loopback MCP server on `127.0.0.1:8791` exposing the editor capabilities
   (`editor_read_file`, `editor_search`, `editor_repo_map`, `editor_retrieve`,
   `editor_diagnostics`, `editor_propose_edit`, `editor_run_command`, `editor_undo_last_edit`);
2. upserts the `vscode-editor-tools` connector into TrueForge at
   `http://127.0.0.1:8791/mcp`;
3. loads the agent definition from [`.trueforge/agents/forge-editor.json`](./.trueforge/agents/forge-editor.json)
   — instructions, the primary model, preloaded editor tools, and per-tool approval
   requirements (`editor_propose_edit`, `editor_run_command` and
   `editor_undo_last_edit` require human approval; nothing touches disk before you
   accept the hunks in the review UI).

Open the Cline view in the Activity Bar, pick **Act**, type a task, and accept or reject
each proposal inline. The diff preview is per-hunk, exactly as accepted/rejected in chat;
an applied change can be undone like any other Cline edit.

### Judged tasks (flask 3.1.3)

Clone and check out the pinned tag, then open it as the workspace:

```bash
git clone https://github.com/pallets/flask flask3 && cd flask3 && git checkout 3.1.3
```

- **Task A** (inline edit): `Select the function get_debug_flag ...` — accept the hunks,
  then verify `FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"` prints `False`.
- **Task B** (agent mode): `Add a new built-in CLI command flask config ...` (exact wording
  in the competition brief) — the diff touches `src/flask/cli.py`, `tests/test_cli.py`,
  `docs/cli.rst` and `docs/api.rst`; `pytest tests/test_cli.py -q` passes and
  `flask config` prints the loaded config as JSON with SECRET/PASSWORD/TOKEN/KEY values
  masked as `***`.
- **Task C** (resilience): point TrueForge at an unreachable endpoint (Settings → Models →
  change the provider `base_url`), repeat Task A — the editor stays responsive, the chat
  shows the harness's own error (`[Model Error] Cannot connect to API: bad port`) with
  Retry / Start New Task, and `git status` stays clean. Restore the provider and save.

### What changed vs upstream (delta judges evaluate)

43 files changed from the fork point, all committed on `forge`. See
[`docs/adr/0001-fork-cline.md`](./docs/adr/0001-fork-cline.md) for the fork declaration
and [`GATES.md`](./GATES.md) for the Round 1 verification ledger. In short: the Cline
agent loop is replaced by TrueForge sessions/turns; editor capabilities are exposed as
MCP tools to the TrueForge agent; diff review flows through TrueForge tool approval;
streaming/cancellation flow through the same SDK machinery.

### Safety contract (what the review gate guarantees)

- `editor_propose_edit` never writes without a recorded per-hunk review. If the diff
  review did not run (or was dismissed), the tool returns `status: "unreviewed"` and
  the file is untouched — approval in chat means "the agent may apply", not "apply
  everything".
- Forge's write tools (`editor_propose_edit`, `editor_undo_last_edit`) are never
  auto-approved, even when the AutoApproveBar's "Use MCP servers" toggle is on.
- A review is bound to its tool call: if the user reviews and then rejects the call,
  the review is discarded, so an identical later proposal cannot inherit it.
- `editor_undo_last_edit` restores the exact pre-edit bytes and refuses if the file
  changed after that edit.
- Cancelling while a tool approval is on screen sends a denial; a cancel during retry
  backoff is not retried. Cancellation bounds the harness cancel request so a stalled
  acknowledgement cannot leave a spinner running.

### Verify locally

```bash
cd apps/vscode
bunx tsc --noEmit                                  # type check
bunx vitest run --config vitest.config.ts           # extension unit tests
node ../../.unlazy/verify/mcp-tools.mjs             # 8 editor tools on 127.0.0.1:8791
node ../../.unlazy/verify/writeup.mjs               # write-up has the 8 required headings
node ../../.unlazy/verify/demo-script.mjs           # demo script covers A/B/C
```

The Flask demo repository must stay on tag `3.1.3` (commit `22d92470`). All judged
runs start from a clean checkout (`git status` empty).

<p align="center">
  <img src="assets/icons/icon.png" width="80" alt="Cline" />
</p>

<h1 align="center">Cline</h1>

<p align="center">
The open source coding agent in your IDE, terminal, & desktop!
</p>

<div align="center">

<div align="center">
<table>
<tbody>
<td align="center">
<a href="https://docs.cline.bot" target="_blank"><strong>Docs</strong></a>
</td>
<td align="center">
<a href="https://discord.gg/cline" target="_blank"><strong>Discord</strong></a>
</td>
<td align="center">
<a href="https://www.reddit.com/r/cline/" target="_blank"><strong>r/cline</strong></a>
</td>
<td align="center">
<a href="https://github.com/cline/cline/discussions/categories/feature-requests?discussions_q=is%3Aopen+category%3A%22Feature+Requests%22+sort%3Atop" target="_blank"><strong>Feature Requests</strong></a>
</td>
<td align="center">
<a href="https://cline.bot/join-us" target="_blank"><strong>Join us!</strong></a>
</td>
</tbody>
</table>
</div>

</div>

<br>

<div align="center">
<table>
<tr>
<td align="center" width="50%">

### CLI

Run Cline in your terminal.
Interactive chat or fully headless 
for CI/CD and scripting.

```
npm i -g cline
```

<a href="./apps/cli/README.md">Learn more</a>
<br><br>

</td>
<td align="center" width="50%">

### Desktop App

Cline as a native app for macOS and Windows.
Run agent sessions in any folder, schedule
routines, and manage models, plugins, and MCP servers.

<a href="https://cline.bot/desktop">Download for macOS and Windows</a>
<br><br>

</td>
</tr>
<tr>
<td align="center" width="50%">

### VS Code Extension

AI coding assistant in your editor.
Create files, run commands, browse the web,
and use tools with human-in-the-loop approval.

<a href="https://marketplace.visualstudio.com/items?itemName=saoudrizwan.claude-dev">Install from VS Marketplace</a>
<br><br>

</td>
<td align="center" width="50%">

### JetBrains Plugin

The same Cline experience in IntelliJ IDEA,
PyCharm, WebStorm, GoLand, and the rest of
the JetBrains family.

<a href="https://plugins.jetbrains.com/plugin/28247-cline">Install from JetBrains Marketplace</a>
<br><br>

</td>
</tr>
</table>
</div>

<div align="center">
<table>
<tr>
<td align="center">

### SDK

Build your own AI agents and integrations powered by the same engine that runs the CLI, desktop app, VS Code extension, and JetBrains plugin. Custom tools, multi-agent teams, connectors, scheduled automations, and more.

```
npm install @cline/sdk
```

<a href="https://docs.cline.bot/cline-sdk/overview">Documentation</a>
<br><br>

</td>
</tr>
</table>
</div>

---

## Index

| Product | Description | Location | CHANGELOG |
|---------|------------|--------------|--------------|
| **SDK** | Node.js programmatic agent API and extension exports. | [`sdk/`](https://github.com/cline/cline/tree/main/sdk) | [CHANGELOG.md](https://github.com/cline/cline/blob/main/sdk/CHANGELOG.md) |
| **CLI** | Terminal UI, headless mode, shell commands, and CLI-specific flows. | [`apps/cli/`](https://github.com/cline/cline/tree/main/apps/cli) | [CHANGELOG.md](https://github.com/cline/cline/blob/main/apps/cli/CHANGELOG.md) |
| **VS Code Extension** | The Marketplace extension and extension host integration. | [`apps/vscode/`](https://github.com/cline/cline/tree/main/apps/vscode) | [CHANGELOG.md](https://github.com/cline/cline/blob/main/CHANGELOG.md) |
| **Desktop App** | Native macOS and Windows app (Tauri shell, Bun sidecar, Next.js UI). | [`apps/examples/desktop-app/`](https://github.com/cline/cline/tree/main/apps/examples/desktop-app) | [CHANGELOG.md](https://github.com/cline/cline/blob/main/apps/examples/desktop-app/CHANGELOG.md) |
| **JetBrains Plugin** | JetBrains-hosted client that talks to the shared agent core. | Currently we are not open-sourcing JetBrains plugins | - |
| **Docs site** | Public documentation pages. | [`docs/`](https://docs.cline.bot/) | - |

## Edits Code Across Your Project

Cline reads your project structure, understands the relationships between files, and makes coordinated changes across your codebase. It monitors linter and compiler errors as it works, fixing issues like missing imports, type mismatches, and syntax errors before you even see them. In VS Code and JetBrains, every edit shows up as a diff you can review, modify, or revert. All changes are tracked with checkpoints, so you can easily undo the agent's work.

## Runs Bash Commands

Cline executes commands directly in your terminal and watches the output in real time. Install packages, run build scripts, execute tests, deploy applications, manage databases. For long-running processes like dev servers, Cline continues working in the background and reacts to new output as it appears, catching compile errors, test failures, and server crashes as they happen.

## Plan and Act

Toggle between Plan mode and Act mode. In Plan mode, Cline explores your codebase, asks clarifying questions, and lays out a strategy. Once you're aligned, switch to Act mode and Cline executes the plan. Every file edit and terminal command requires your approval, so you stay in control of what actually changes. Or toggle auto-approve and let Cline run autonomously.

## Rules and Skills

Define project-specific rules in `.clinerules` files that guide how Cline works in your codebase: coding standards, architecture conventions, deployment procedures, testing requirements. Rules are picked up automatically by the CLI, VS Code extension, and JetBrains plugin. Use skills to let the model load specific rules when needed.

## Works With Every Model

Cline is not locked to a single AI provider. Use whichever model fits your workflow:

| Provider | Models |
|----------|--------|
| Anthropic | Claude Opus, Sonnet, Haiku |
| OpenAI | GPT series models |
| Google | Gemini series models |
| OpenRouter | 200+ models from any provider |
| Vercel AI Gateway | Route to many providers through one gateway |
| AWS Bedrock | Claude, Llama, and more |
| Azure / GCP Vertex | All hosted models |
| Cerebras / Groq | Fast inference models |
| Ollama / LM Studio | Run local models on your machine |
| Any OpenAI-compatible API | Self-hosted or third-party endpoints |

## Extend With Plugins or MCP Servers

Extend Cline's capabilities with plugins. Using the SDK, register tools and lifecycle hooks programmatically through the plugin system for logging, auditing, policy enforcement, or adding domain-specific capabilities. Simple plugin example below.

```typescript
import { Agent, createTool } from "@cline/sdk"

const deployTool = createTool({
  name: "deploy",
  description: "Deploy the current branch to staging.",
  inputSchema: { type: "object", properties: { env: { type: "string" } }, required: ["env"] },
  execute: async (input) => {
    // your deployment logic
  },
})

const agent = new Agent({ tools: [deployTool], /* ... */ })
```
...or use [MCPs](https://github.com/modelcontextprotocol) to connect to databases, query APIs, manage cloud infrastructure, and interact with external systems. Use [community-built servers](https://github.com/modelcontextprotocol/servers) or ask Cline to create custom tools on the fly. In the CLI, manage servers with `cline mcp`.

## Multi-Agent Teams

Coordinate multiple agents working together on complex tasks. A coordinator agent breaks the work into subtasks and delegates to specialist agents, each with their own tools and context. Team state persists across sessions so you can pick up where you left off.

```bash
cline --team-name auth-sprint "Plan and implement user authentication with tests"
```

## Scheduled Agents

Run agents on cron schedules for recurring automations. Daily PR summaries, weekly dependency checks, codebase health reports. Schedules persist across restarts and run independently of any terminal session.

```bash
cline schedule create "PR summary" \
  --cron "0 9 * * MON-FRI" \
  --prompt "List all open PRs and their review status" \
  --workspace /path/to/repo
```

## Connect to Slack, Telegram, Discord, and More

Chat with your agent from any messaging platform: Telegram, Slack, Discord, Google Chat, WhatsApp, and Linear. Each conversation thread maps to an agent session with full context. Set up access control to restrict who can interact with your agent.

```bash
# Connect to Telegram
cline connect telegram -k $BOT_TOKEN
# Connect to Slack through webhook
cline connect slack --bot-token $SLACK_TOKEN --signing-secret $SECRET --base-url $URL
# Connect to Slack using socket mode
cline connect slack --bot-token $SLACK_TOKEN --app-token $SLACK_APP_TOKEN
```

## Headless CLI for CI/CD

Run Cline with zero interaction for scripting and automation. Pipe input, get JSON output, chain commands, integrate into CI/CD pipelines.

```bash
cline "Run tests and fix any failures"
git diff origin/main | cline "Review these changes for issues"
cline --json "List all TODO comments" | jq -r 'select(.type == "agent_event" and .event.text) | .event.text'
```

## Contributing

Start with the [Contributing Guide](CONTRIBUTING.md). Join our [Discord](https://discord.gg/cline) and head to the `#contributors` channel to connect with other contributors. Check our [careers page](https://cline.bot/join-us) for full-time roles.

## License

[Apache 2.0 © 2026 Cline Bot Inc.](./LICENSE)
