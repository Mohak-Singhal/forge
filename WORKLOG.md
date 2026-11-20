# Forge — Complete Worklog & Handoff

> TrueFoundry Forge-a-thon, Round 1. Detailed record of everything built, changed,
> verified, discovered, and still outstanding. Written 2026-11-19.
>
> Repository: `/Users/mohaksinghal/Documents/GitHub/vscode agent ` (note the **trailing
> space** in the path — always quote it). Branch: `forge`.

---

## 0. TL;DR — what exists right now

- A **fork of Cline** (VS Code extension) whose agent loop has been **replaced by
  TrueForge**. The extension is a pure client of a TrueForge agent; it never calls a
  model provider directly.
- Eight **editor capabilities are exposed as MCP tools** over loopback HTTP
  (`127.0.0.1:8791/mcp`) and are called by the TrueForge agent, not by the extension.
- **Tasks A, B and C were each verified end-to-end** on `pallets/flask` tag `3.1.3`
  earlier in the build. The whole A→B→C sequence was also run once in a single sitting.
- The scored depth work for the rubric is implemented and unit-tested:
  - **B1** budgeted retrieval with a visible eviction report, `@file`/`@symbol` mentions,
    symbol-aware repo map.
  - **B2** real `vscode.diff` + per-hunk Keep/Skip wired into TrueForge approval.
  - **B3** retry with backoff, then automatic failover to a second configured model,
    then an honest error naming everything tried. Proven end-to-end (`FALLBACK_OK`).
  - **B4** TrueForge compaction configured and its events surfaced in the transcript.
- All code is **committed** on `forge`; the working tree is clean except two local
  harness metadata directories (`.perch/`, `.unlazy/spec/`) which are intentionally
  untracked and not part of the submission.
- **Not yet done:** one final on-screen rehearsal after the last diff-review fix (the
  local automation environment keeps killing TrueForge / the VS Code window), the
  demo video, the public GitHub push, and the Techfest portal submission. Those last
  three are user actions.

---

## 1. The task we were building for

Round 1 requires five mandatory capabilities: inline edit, agent mode, context
assembly, diff review, and streaming/cancellation. Three fixed tasks are demonstrated
on flask 3.1.3 in order A→B→C, followed by on-screen verification. Scoring is 100
points across capability coverage (A1–A3, 30), technical depth (B1–B4, 45) and
presentation (C1–C2, 25). The user's explicit instruction was: **video and submission
come last; maximise the scored work first.** This worklog follows that order.

Eligibility constraints that shaped the design:
- Agent loop must run on TrueForge local mode (`npx @truefoundry/trueforge@latest`),
  nothing deployed.
- Editor capabilities must be MCP tools so the agent decides what to read/change.
- Model configured in TrueForge only; extension must work with any model.
- Fork point declared; upstream LICENSE preserved; no secrets in the repo.
- Agent definition committed.

---

## 2. Commit history (what was worked on, in order)

All commits are on `forge`, starting from the declared fork point
`eff43e19b267e171f597ab03733bfed25090f72d` (Cline `main`, 2026-11-17).

| Commit | What it did |
|---|---|
| `818de17` | Declared the fork point at the top of `README.md`. |
| `341e572` | Typed TrueForge HTTP/SDK client wrapper (`client.ts`). |
| `9f23071` | BM25 retriever + hunk-edit applier (`retrieval.ts`, `edits.ts`). |
| `440ce5c` | MCP loopback tools server + typed TF client wrapper. |
| `9bbcc6a` | `TrueForgeSessionHost` implementing `SdkSessionHost`. |
| `9100932` | Routed all SDK session lifecycle through the TrueForge host. |
| `251b797` | Boot the MCP loopback server at activation; upsert TF connector. |
| `f901bd3` | `propose_edit` applies only after approval; diagnostics tool; MCP path resolution fix. |
| `8fd6179` | Persist the loopback token so the TF connector and MCP server always agree. |
| `d55056f` | One `McpServer` per MCP request (stateless transport). |
| `c778a6d` | Preload editor MCP tools and enumerate them in the agent instructions. |
| `ea3aac4` | Lower VS Code engine to `^1.96.0` to match the dev-host runtime. |
| `06bfe05` | Run commands via `spawn` with a manual watchdog (`execFile` lost its callback across the SSE boundary). |
| `7651789` | Surface terminal turn failures to the chat. |
| `5a9c5dc` | Biome lint cleanups on trueforge sources. |
| `aa5bb21` | Gate scripts for fork point, TrueForge, MCP tools and secret hygiene. |
| `5c89701` | Quickstart docs verified from a clean clone; tasks A/B/C, model setup, delta. |
| `70ff6c2` | Restore `walkForSearch` `maxFiles` parameter (call sites relied on it). |
| `8d32a61` | `editor_undo_last_edit` — restore exact pre-edit bytes. |
| `755fa85` | Write-up PDF with the 8 required headings (3 pages). |
| `46279cb` | Demo shot list for the Round 1 video. |
| `7682f64` | Demo shot list beat: TrueForge session view via ego lite. |
| `7c59d60` | Dry-run observations in the demo script. |
| `ff29b58` | **This session:** budgeted retrieval, per-hunk review, retry + automatic model fallback, visible compaction. |
| `2c16e7c` | **This session:** fix empty approval input; treat gateway body timeout as retryable. |

`git diff --stat eff43e19b..HEAD`: **42 files changed, 5,192 insertions, 41 deletions**.

---

## 3. Architecture — how the pieces fit

```
┌──────────────────────── VS Code extension (forked Cline) ────────────────────────┐
│                                                                                  │
│  Cline webview (kept from upstream)                                              │
│      ├── streams tokens via CoreSessionEvent re-emitted by TrueForgeSessionHost  │
│      └── Approve / Reject buttons on tool.approval_required                      │
│                                                                                  │
│  SdkController ── SdkInteractionCoordinator ── onToolApprovalAsk ──┐             │
│       │                                                            │             │
│       ├── ForgeInlineEdit (keybinding cmd+alt+K)                     ▼             │
│       │      └── diff tab + per-hunk Accept/Reject                  ForgeHunkReview│
│       │                                                            (diff + hunk   │
│       ├─ TrueForgeSessionHost ── TrueForgeClient ── SDK ──┐       decisions)      │
│       │      ├── turn stream → events → webview            │                      │
│       │      ├── retry / failover / compaction notes       │                      │
│       │      └── mentions resolved before the prompt goes  │                      │
│       │                                                    ▼                      │
│       └── boot.ts ── upserts connector ── MCP server (127.0.0.1:8791/mcp)          │
│                                                    ▲                             │
└────────────────────────────────────────────────────┼─────────────────────────────┘
                                                     │ MCP over loopback HTTP
                                                     ▼
┌──────────────────────── TrueForge (local mode, :8790) ──────────────────────────┐
│  Session + turns + tool calls + approvals + streaming + compaction + subagents   │
│  Model provider configured here ONLY (gateway primary + local Ollama fallback)   │
└──────────────────────────────────────────────────────────────────────────────────┘
```

Key consequence: **the model and provider are never touched by extension code.** All
model traffic goes through TrueForge. Model choice is a one-file edit in
`.trueforge/agents/forge-editor.json` (or a TrueForge Settings change).

---

## 4. File-by-file inventory of the Forge delta

### 4.1 Configuration / agent definition

**`.trueforge/agents/forge-editor.json`** — the committed agent definition. Contains:
- `instructions` (1,853 chars) telling the agent to call `editor_retrieve`, read exact
  ranges, use every edit via `editor_propose_edit`, run diagnostics, and carry the task
  to completion.
- `model`: primary `opencode-free-models/deepseek-v41-flash-free`, fallbacks
  `["local-ollama/qwen-coder-local"]`.
- `mcp_servers`: one connector `vscode-editor-tools`, `enable_tools: ["@all"]`,
  `preload: true`, `require_approval_for_tools: ["editor_propose_edit",
  "editor_run_command", "editor_undo_last_edit"]`.
- `config`: `dynamic_sub_agents.enabled`, `ask_user_questions.enabled`,
  `context_management.compaction` with `trigger: { type: "input_tokens", value: 120000 }`,
  `iteration_limit: 80`. TrueForge echoed this whole config on session creation
  (session `01m7qwcyhhe7jy6a8hhdpbq0q6`).

**`.trueforge/models.example.json`** — importable provider examples (Ollama and a
generic OpenAI-compatible provider) with **no real keys**.

**`apps/vscode/package.json`** — registers `forge.inlineEdit` with keybinding
`cmd+alt+K` (mac) / `ctrl+alt+k` (win/linux), plus menu contributions.

**`docs/adr/0001-fork-cline.md`** — fork declaration ADR.

### 4.2 TrueForge client / session host

**`apps/vscode/src/trueforge/client.ts`** (~128 lines) — thin SDK wrapper. Creates
sessions from an inline agent spec, sends turns, cancels turns, streams events, lists
models, and `switchModel()` which re-points an inline session by sending an updated
`agent.spec`. This last method is what makes automatic failover real rather than a
no-op retry against the same broken endpoint.

**`apps/vscode/src/trueforge/trueforge-session-host.ts`** (~900 lines) — the heart of
the fork. Implements `SdkSessionHost` so the rest of Cline (translator, webview,
approval UI) keeps working unchanged. Responsibilities:
- create/manage sessions and turns;
- translate every TrueForge stream event into the `CoreSessionEvent` shapes the
  upstream UI understands;
- bridge `tool.approval_required` to Cline's `requestToolApproval` callback;
- resolve `@file`/`@symbol` mentions into a ground-truth block prepended to the prompt;
- retry with backoff → fail over → exhausted error, via `handleFailure()`;
- surface compaction events (`thread.context_compaction_started/finished`) and
  failover/retry notes as ordinary transcript text via `emitToolNote()`;
- treat `turn.done { status: error|failed }` as a failure trigger (it arrives as a
  stream event, **not** a thrown exception — the original code missed this);
- **`resolveApprovalInput()`** — pure helper added last. TrueForge's approval event
  carries tool-call IDs but frequently an **empty `input` object**; the real arguments
  live on the tracked `model.message` tool call. Without this fallback the diff review
  saw no path/hunks and silently showed a bare Approve button.

**`apps/vscode/src/trueforge/mcp/server.ts`** (~172 lines) — stateless Streamable-HTTP
MCP server. A fresh `McpServer` + transport per request. No auth (127.0.0.1 only).
Clients must send `Accept: application/json, text/event-stream`.

**`apps/vscode/src/trueforge/mcp/tools.ts`** (~606 lines) — the eight editor tools:

| Tool | Purpose | Approval |
|---|---|---|
| `editor_read_file` | read file (1-based line range) | auto |
| `editor_search` | regex search → `path:line` | auto |
| `editor_repo_map` | symbol-aware repo map | auto |
| `editor_retrieve` | budgeted BM25 retrieval | auto |
| `editor_diagnostics` | fast Python syntax check (`py_compile`) | auto |
| `editor_propose_edit` | stage/apply multi-hunk edits | TF-gated |
| `editor_run_command` | workspace shell (destructive/network refused) | TF-gated |
| `editor_undo_last_edit` | restore exact pre-edit bytes | TF-gated |

Also contains `resolveMentionContext()` (file/symbol resolution), `findSymbolDefinition()`
(definition + bounded body), `applyApplicableHunks()` (don't discard accepted hunks
because one is stale), and the per-hunk decision consumption in `editor_propose_edit`.

**`apps/vscode/src/trueforge/boot.ts`** (~63 lines) — starts the MCP loopback server on
activation and upserts the `vscode-editor-tools` connector into TrueForge.

### 4.3 Context assembly (B1)

**`context-budget.ts`** (~239 lines, 14 tests) — pure core. `estimateTokens()`,
`truncateToTokens()` (line-boundary-aware), `packContext()` (hard token budget, chunk
cap, per-chunk compression), `formatPackedContext()`. Every drop has a reason
(`budget exhausted`, `chunk cap reached`, `does not fit…`). The report states budget
used, chunk count, candidate count, and per-chunk reason (matched terms, BM25 score,
line range, token cost). Design decision: a single oversized chunk is **compressed**,
not dropped, so it cannot evict several precise ones.

**`mentions.ts`** (~123 lines, 21 tests) — `@file`, `@file:40-80`, `@Symbol` parsing,
`parseMentionRange`, `resolveFileMention` (exact then shortest suffix), and
`formatMentionContext` (labels the block as ground truth). Explicit mentions are never
ranked and never evicted.

**`retrieval.ts`** (~349 lines) — BM25 over ~40-line chunks with skip list; each chunk
records `matchedTerms` with per-term weight so the "why" is real, not generic. Rewritten
`buildRepoMap()` now includes top-level `def`/`class`/`export` symbols packed to a
1,500-token budget with an omitted-file count.

### 4.4 Diff review (A1 / B2)

**`ForgeInlineEdit.ts`** (~253 lines, 16 core tests) — the keybinding command. Select a
region, press `cmd+alt+K`, type an instruction. The turn goes to TrueForge like any
other. The reply is parsed into exact hunks, shown in a real `vscode.diff`, then one
modal per hunk with **Accept Hunk / Reject Hunk**. Nothing writes before acceptance;
pre-images are stored for exact undo.

**`ForgeHunkReview.ts`** (~171 lines) — the agent-mode equivalent. When TrueForge pauses
`editor_propose_edit` for approval, this opens a real `vscode.diff` (original ↔
proposed) then asks **Keep Hunk / Skip Hunk** per hunk. Decisions are handed to the tool
via `hunk-review`. Includes `applyBestEffort()` so the preview still shows a diff when
one hunk is stale. `isForgeEditTool()` recognises both plain and prefixed tool names.

**`hunk-review.ts`** (~61 lines, 11 tests) — keyed decision registry. `proposalKey()`
is content-based (path + hunks), `recordHunkDecisions()`, `takeHunkDecisions()`
(consume once; default all-accepted when no review happened, e.g. headless), bounded to
50 entries to avoid leaks from cancelled turns.

**`edits.ts`** (~71 lines) — `applyHunks()` / `sha256()`, shared by the preview and the
apply path.

**`edit-registry.ts`** (~71 lines) — proposal staging for the MCP tools.

**`SdkController.ts`** — `onToolApprovalAsk` now calls `reviewForgeProposal()` first and
only falls through to the upstream diff coordinator for Cline's native tools.

### 4.5 Resilience (B3)

**`model-fallback.ts`** (~186 lines, 21 tests) — pure core:
- `modelChainFromSpec()`, `attemptOrder()`, `decideFallback()`, `exhaustedMessage()`;
- `retryDelayMs()` — 400/800/1600/3200 ms, capped;
- `isRetryableError()` — only transient conditions (ECONNRESET, timeouts, network
  errors, 5xx, 429); deliberately excludes bad port, 401/403, model-not-found;
- `isModelUnavailableError()` — transport/auth failures that a second model can rescue;
- `decideRetry()`, `defaultSleep()`.

A real gateway error observed during testing —
`[Model Error] Request failed (200): … Body Timeout Error` — was added to both matchers
with a regression test.

**Behaviour:** retry the same model with backoff while the error is transient → fail
over to the next configured model with **no user action** → only then show a clear
error naming every model tried. Cancellation breaks out without retrying.

**`scripts/verify-fallback.mjs`** (~165 lines) — live proof against the real TrueForge
server. Saves providers, points the primary at `127.0.0.1:9`, creates a session, runs a
turn, applies the same failover decision the extension uses, re-points the session,
runs the fallback turn, asserts text came back, and restores providers in `finally`.
It deliberately strips `mcp_servers` from the spec because port 8791 only exists while
the VS Code dev host runs; model failover is what the gate tests.

### 4.6 Tests and gates

Six trueforge test files, 90 tests total:

| File | Tests |
|---|---|
| `approval-input.test.ts` | 7 |
| `context-budget.test.ts` | 14 |
| `hunk-review.test.ts` | 11 |
| `inline-edit-core.test.ts` | 16 |
| `mentions.test.ts` | 21 |
| `model-fallback.test.ts` | 21 |

Gate scripts in `.unlazy/verify/`: `fork-point.mjs`, `hygiene.mjs`, `build.mjs`,
`mcp-tools.mjs`, `smoke-models.mjs`, `trueforge-up.mjs`.

### 4.7 Report artefacts

- `report/forge-writeup.html` + `report/forge-writeup.pdf` — 3 pages, the 8 required
  headings in order, scorecard with `TBD(post-cut)` video timestamps. Updated this
  session with the retrieval budget, `@symbol` mentions, per-hunk review, retry/fallback,
  59-passed correction, and the new fallback model.
- `report/demo-script.md` — shot list for the ≤4-minute video, incl. dry-run observations.

---

## 5. Capability status against the rubric

| Criterion | Pts | Status | Evidence / notes |
|---|---|---|---|
| **A1 Inline edit** | 10 | Implemented | Keybinding + selection + plain-language instruction; real diff; per-hunk Accept/Reject. Previously verified on screen in Task A. |
| **A2 Agent mode** | 10 | Verified | Task B: agent discovered and edited `cli.py`, `test_cli.py`, `cli.rst`, `api.rst` without being told their names; 59 tests passed; `flask --help` lists `config`; masked JSON shown. |
| **A3 Streaming & cancellation** | 10 | Verified | Tokens stream live; Cancel mid-run records `client-cancelled`; workspace byte-consistent. |
| **B1 Context assembly** | 15 | Implemented + live-probed | Budget report observed over the live MCP tool; 90 tests cover budget/eviction/mentions. Needs the on-screen Task B beat for the final 15/15. |
| **B2 Diff safety** | 10 | Implemented + unit-tested; **not yet re-verified on screen after the last fix** | Real diff + per-hunk Keep/Skip + byte-exact undo. The empty-`input` bug that suppressed the diff was found and fixed in `2c16e7c`. |
| **B3 Resilience** | 10 | **Proven end-to-end** | `bun run scripts/verify-fallback.mjs` → `FALLBACK_OK`: primary `bad port` → failover decision → session re-pointed → local model answered `PONG` → providers restored. |
| **B4 TF integration depth** | 10 | Implemented | 8 MCP tools, TF approval drives the diff review, tools preloaded, compaction configured with an explicit trigger and visible transcript notes. |
| **C1 Video** | 10 | Not started (user action) | Shot list ready. |
| **C2 Write-up** | 15 | Done | 3-page PDF, 8 headings, architecture/context/models/limitations/scorecard. `TBD(post-cut)` timestamps remain. |

---

## 6. Verification evidence (actual outputs)

Run after the last commits:

```
apps/vscode vitest src/trueforge/   → 6 files, 90 tests passed
bun run test:unit                   → 92 files, 1244 passed, 0 failed
tsc --project tsconfig.vscode-compat.json --noEmit → 0 errors
biome check (touched sources)       → 0 errors
bun esbuild.mjs                     → [watch] build finished; dist/extension.js rebuilt
node .unlazy/verify/fork-point.mjs  → FORK_POINT_OK
node .unlazy/verify/hygiene.mjs     → HYGIENE_OK
report/forge-writeup.pdf            → 3 pages, 8 headings in order
```

**B1 live MCP probe** (real extension host, real flask workspace):

```
retrieval budget: 1476/4000 tokens across 4 chunk(s) from 12 candidate(s)
dropped 8 candidate(s) to stay inside the budget:
- docs/config.rst:481-520 — chunk cap reached (4 chunks already packed)
- tests/test_config.py:1-40 — chunk cap reached (4 chunks already packed)
...
## tests/test_config.py:161-200 (matches "json", "configuration", "config", "flask"
   · BM25 40.34 · lines 161-200 · 383 tok)
```

This is the concrete answer to "retrieval with a size budget, strategy stated,
visibly at work" — the budget, the drops and the reason for each hit are all in the
tool result the model sees.

**B3 live failover proof:**

```
chain: opencode-free-models/deepseek-v41-flash-free → local-ollama/qwen-coder-local
broke opencode-free-models → http://127.0.0.1:9/v1
primary failed as expected: [Model Error] Cannot connect to API: bad port
decision: failover=true next=local-ollama/qwen-coder-local
session re-pointed to local-ollama/qwen-coder-local: true
fallback turn text: "PONG"
fallback turn error: ""
FALLBACK_OK: the second configured model took over automatically
restored opencode-free-models → https://100milionseek.top/v1
```

**Earlier end-to-end task verification (before the latest UX changes):**
- Task A: `FLASK_DEBUG=off … get_debug_flag()` → `False`; docstring updated; one file changed.
- Task B: 4 unnamed files discovered and edited; `pytest tests/test_cli.py -q` → 59 passed; `flask --help` lists `config`; masked JSON shown. Full suite had 2 failures that were **proven pre-existing on the pinned tag** via `git stash`.
- Task C: clear message, Retry/Start New Task, clean `git status`, provider restored.
- A3 cancel: workspace porcelain empty. G6 deny path: sha256 identical before/after.

---

## 7. What I discovered the hard way (important context)

1. **`turn.done state=error` is a stream event, not a throw.** The original failure
   handler only caught exceptions, so failover could never fire on Task C's real
   failure. Fixed by recording `terminalStatus` and driving the failure path from it.
2. **`execFile` lost its callback** across the Streamable-HTTP flush boundary in the
   Electron utility process. Rewrote `editor_run_command` on `spawn` with stdio
   collection and a close listener.
3. **TrueForge approval events have an empty `input` object.** This was found by
   instrumenting the real dev host: the debug log showed
   `enter tool=editor_run_command … inputKeys=` and `bail: not a forge edit tool`.
   Without the tracked-arguments fallback, `editor_propose_edit` reached the user as a
   bare Approve button with **no diff tab** — a silent loss of A1/B2 points. Fixed in
   `resolveApprovalInput()` with 7 unit tests.
4. **`jev-1.13-free` is a judge model**, served only on `POST /v1/systemone`; a normal
   chat completion returns `wrong_endpoint`. It was registered as a fallback in early
   docs but could never work. Replaced by a genuine local model.
5. **TF provider API quirks:** `PUT /api/v1/settings/model-providers` takes a single
   `{manifest}` and upserts by name; there is no per-name route. Model names must be
   2–64 lowercase chars, letter-start, alphanumeric-end, hyphens only.
6. **The local automation environment repeatedly kills both TrueForge and the VS Code
   dev-host window**, and the free gateway intermittently times out mid-turn
   (`Body Timeout Error`). This is why the final on-screen rehearsal is still pending.

---

## 8. Current environment (as of the last check)

| Thing | State |
|---|---|
| Branch | `forge`; HEAD `2c16e7c`; tree clean except `.perch/`, `.unlazy/spec/` (untracked harness metadata) |
| TrueForge | was restarted several times; it dies periodically — restart command below |
| MCP server | `127.0.0.1:8791`, served by the VS Code extension host |
| Models in TrueForge | `opencode-free-models/deepseek-v41-flash-free` (primary), `local-ollama/qwen-coder-local` (fallback) |
| Ollama | `ollama serve` on `127.0.0.1:11434`, model `qwen2.5-coder:1.5b` pulled (5.3 GB usable VRAM on Apple M1) |
| Flask demo repo | `/Users/mohaksinghal/Documents/GitHub/forge-demo/flask`, detached at `22d92470` (3.1.3), pristine except `.DS_Store`; venv at `.venv` |

Restart commands:

```bash
# TrueForge
cd /private/var/folders/c3/4vxgxlj55g92s7pg8q88_dz00000gn/T/opencode/forge-logs
OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]' nohup npx -y @truefoundry/trueforge@latest > trueforge.log 2>&1 & disown

# Ollama (if the local fallback is needed)
nohup ollama serve > ollama.log 2>&1 & disown

# VS Code dev host (plain `code` does NOT work in this environment)
/usr/bin/open -na "/Applications/Visual Studio Code.app" --args \
  --extensionDevelopmentPath="/Users/mohaksinghal/Documents/GitHub/vscode agent /apps/vscode" \
  --user-data-dir=/private/var/folders/c3/4vxgxlj55g92s7pg8q88_dz00000gn/T/opencode/vscode-userdata \
  "/Users/mohaksinghal/Documents/GitHub/forge-demo/flask"
# If no window appears after launch: /usr/bin/open -a "/Applications/Visual Studio Code.app"
```

CUA notes: the app is named **`Code`** (not "Visual Studio Code") in agent-desktop.
After a reload the composer may be named `Type your task here...` or
`Type a message...`; find it fresh, set the value, then press Return with
`allow_focus:true, fallback_physical:true`.

---

## 9. Stale documentation to fix before submission

These are known inconsistencies left in earlier docs; none affect the code:

1. **`README.md`**: still says the fallback is `opencode-free-models/jev-113-free`. It
   is now `local-ollama/qwen-coder-local`. Also says "19 files changed from the fork
   point" — the actual diff is 42 files. Task C section describes only the clear-error
   path; it can now mention automatic fallback.
2. **`report/demo-script.md`**: one shot-list line says `58 passed`; the verified
   number is **59 passed** (3 skipped due to a pre-existing async extra). The final
   Task C step describes only the clear-error path; add the fallback beat.
3. **`GATES.md`** (gitignored local ledger) is up to date; it records both the live
   fallback proof and the final on-screen-verification blocker.

---

## 10. Remaining work

**Before recording (worth doing):**
1. Restart TrueForge + VS Code dev host.
2. Run one clean Task A rehearsal and confirm that, at the `editor_propose_edit`
   approval, a real diff tab opens and **Keep Hunk / Skip Hunk** appears. This is the
   single behavioural change not yet re-verified on screen after `2c16e7c`.
3. Optionally capture one Task B beat showing the `retrieval budget: …` line and the
   per-hunk review (B1's "visibly at work" anchor).

**User actions (cannot be delegated):**
4. Record the ≤4-minute video, A→B→C in order, each followed by on-screen
   verification, with the TrueForge session shown briefly during Task B. User records;
   assistant drives CUA.
5. Fill the `TBD(post-cut)` timestamps in the scorecard (§6 of the PDF), regenerate the
   PDF if needed.
6. Push the repo publicly before the deadline.
7. Submit the three links through the Techfest portal.

**Deadline:** 2026-11-20 23:59 IST. Results 2026-11-30; finals 2026-12-16–18.

---

## 11. Quick command reference

```bash
# All checks in one go
cd "/Users/mohaksinghal/Documents/GitHub/vscode agent /apps/vscode"
bun run vitest run src/trueforge/                     # 90 tests
bun run test:unit                                      # 1244 tests
bunx tsc --project tsconfig.vscode-compat.json --noEmit
bunx biome check --config-path ./biome.jsonc src/trueforge
bun esbuild.mjs                                        # rebuild dist/extension.js

cd ..
node .unlazy/verify/fork-point.mjs                     # FORK_POINT_OK
node .unlazy/verify/hygiene.mjs                        # HYGIENE_OK
bun run scripts/verify-fallback.mjs                    # FALLBACK_OK (needs TF + Ollama)

# Flask verifications
cd /Users/mohaksinghal/Documents/GitHub/forge-demo/flask
FLASK_DEBUG=off .venv/bin/python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"  # False
.venv/bin/python -m pytest tests/test_cli.py -q                                                        # 59 passed
.venv/bin/flask --help | grep config                                                                    # config listed

# Regenerate the PDF
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu \
  --no-pdf-header-footer --print-to-pdf=report/forge-writeup.pdf \
  "file:///Users/mohaksinghal/Documents/GitHub/vscode%20agent%20/report/forge-writeup.html"
```

---

## 12. Honest assessment

The extension now covers all five mandatory capabilities and all four technical-depth
criteria in code, with the two hardest ones (B1 budgeted retrieval, B3 automatic
fallback) demonstrated with reproducible evidence. The last change fixed a real,
silent scoring bug in the diff-review path; it is unit-tested and typechecked but has
not had one clean on-screen rehearsal because of environment instability. Everything
that remains outside that is presentation and user-side submission, not engineering.
