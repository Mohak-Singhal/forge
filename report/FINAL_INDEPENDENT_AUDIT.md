# Forge — Final Independent Audit (Round 1)

Date: 2026-11-19 · Auditor: independent adversarial review of the real implementation
Branch: `forge` · Audited starting HEAD: `91d2ecc`; inspection head after this audit: `c319dfe` (the brief expected `2c16e7c`;
`2c16e7c` **is** an ancestor of `91d2ecc`, so no history was rewritten — the branch simply
had three documentation/audit commits on top). Fork point: `eff43e19b267e171f597ab03733bfed25090f72d` (Cline, Apache-2.0).

Demo repository: `/Users/mohaksinghal/Documents/GitHub/forge-demo/flask`, pinned to
`22d92470` (tag `3.1.3`). It was reset to a clean tree between independent scenarios and
is clean at the end of this audit (only `.DS_Store` is untracked).

---

## 1. Eligibility verdict

**PASS for engineering eligibility. FAIL for submission completeness (no demo video).**

| Gate | Result | Evidence |
|---|---|---|
| Fork of Cline at the declared upstream commit, upstream LICENSE preserved | PASS | `node .unlazy/verify/fork-point.mjs` → `FORK_POINT_OK` |
| Agent loop is TrueForge, not the extension | PASS | `SdkSessionLifecycle` is created with `forgeEngine: "trueforge"`; the only model traffic is `TrueForgeClient` → `localhost:8790`. No provider SDK is called from the extension. |
| Editor capabilities exposed as MCP tools | PASS | `node .unlazy/verify/mcp-tools.mjs` → `MCP_TOOLS_OK` with all 8 `editor_*` tools |
| Eight editor tools registered | PASS | `editor_read_file, editor_search, editor_repo_map, editor_retrieve, editor_run_command, editor_propose_edit, editor_diagnostics, editor_undo_last_edit` |
| Production build | PASS | `node .unlazy/verify/build.mjs` → `BUILD_OK extension.js=26273802B webview=ok` |
| Typecheck | PASS | `bunx tsc --noEmit` → exit 0 |
| Lint | PASS | `bun run package` ran `biome lint`; no errors (after removing leftover scratch scripts) |
| Tests | PASS | 1680 vitest (116 files) + 1244 bun unit tests, 0 failures |
| Write-up PDF, 8 required headings | PASS | `node .unlazy/verify/writeup.mjs` → `WRITEUP_OK`; PDF regenerated, `pdftotext` shows all headings |
| Demo video | **MISSING** | Not recorded by design (out of scope for this run) |
| Public GitHub push / portal submission | **NOT DONE** | Explicitly out of scope |

TrueForge itself was started for this audit (`npx @truefoundry/trueforge@latest`,
v0.185.1, standalone on `localhost:8790`) with the two configured providers. A real model
turn was executed; no model response was faked.

---

## 2. Rubric scorecard

Points below are what is **defensible from executed evidence in this run**, not what the
implementation aspires to. Video points are zero until a real recording exists.

| Criterion | Max | Status | Points now | Why |
|---|---:|---|---:|---|
| A1 Inline edit | 10 | Partial | 7 | Write path, per-hunk apply, reject, and exact undo verified at the tool level; the live editor diff tab / keybinding flow was not clicked in this run. |
| A2 Agent mode | 10 | Pass (headless approval) | 9 | Real TF agent discovered 4 unnamed files, edited them, ran tests, verified `flask --help` and masked JSON. The human click was automated. |
| A3 Streaming / cancellation | 10 | Partial | 8 | Real stream events, cancel-during-backoff and cancel-in-flight verified; live token rendering in the webview not screen-recorded. |
| B1 Context assembly | 15 | Pass | 13 | Real budget report (2220/4000), explicit mentions with line ranges, repo map, deterministic ranking tests. Ranking is lexical BM25, not semantic. |
| B2 Diff safety | 10 | Pass (code + tests) | 8 | Fail-closed review gate, per-hunk acceptance, denial cleanup, stale guards, undo guard. UI diff not automated. |
| B3 Resilience | 10 | Pass | 9 | Real 429 retry, 500/401 clean errors, unreachable-primary failover (session model actually switched), both-unavailable error, cancel. |
| B4 TrueForge integration | 10 | Pass | 9 | Real sessions/turns/stream/approvals/compaction events; `mcp.initialize` preload observed. Compaction events not triggered live. |
| C1 Demo video | 10 | **Not recorded** | 0 | Do not award points without a real video. |
| C2 Write-up | 15 | Partial | 12 | PDF has all 8 headings and corrected facts; repo URL is a placeholder and video timestamps are empty. |
| **TOTAL** | **100** | | **75** | |

**Potential:** ~95/100 once the UI beats are demonstrated on camera and the repo URL /
timestamps are filled in. The remaining 5 are genuine limitations (lexical retrieval,
whole-proposal undo), not missing work.

Realistically, judges anchor on the video: without C1 most of A1–A3 cannot be awarded
even though the engineering is there. Treat 75 as an engineering-readiness score.

---

## 3. What was actually executed (exact commands and results)

### 3.1 Baseline and static checks

```text
$ git rev-parse --abbrev-ref HEAD          -> forge
$ git log -1 --oneline                     -> 91d2ecc docs: add comprehensive worklog …
$ git merge-base --is-ancestor 2c16e7c HEAD -> yes
$ git diff --name-only eff43e19b..HEAD | wc -l -> 43
$ cd apps/vscode && bunx tsc --noEmit      -> exit 0
$ cd apps/vscode && bunx vitest run --config vitest.config.ts
  -> Test Files 116 passed (116) | Tests 1680 passed (1680)
$ cd apps/vscode && bun scripts/run-bun-unit-tests.ts
  -> Files: 92  Pass: 1244  Fail: 0  "All unit test files passed."
$ node .unlazy/verify/build.mjs
  -> BUILD_OK extension.js=26273802B webview=ok
$ node .unlazy/verify/fork-point.mjs       -> FORK_POINT_OK
$ node .unlazy/verify/trueforge-up.mjs     -> TRUEFORGE_UP
$ node .unlazy/verify/mcp-tools.mjs        -> MCP_TOOLS_OK (8 tools)
$ node .unlazy/verify/hygiene.mjs          -> HYGIENE_OK
$ node .unlazy/verify/writeup.mjs          -> WRITEUP_OK 8 headings in order
$ node .unlazy/verify/demo-script.mjs      -> DEMO_SCRIPT_OK 9 checks
```

`smoke-models.mjs` was **not** passing at audit time: the primary model answers, but the
configured fallback `local-ollama/qwen-coder-local` cannot answer because no Ollama daemon
is running on `127.0.0.1:11434`. This is an environment fact, not a code defect, and is
recorded honestly in `GATES.md` (G3 stays unchecked).

### 3.2 Task A — real write path against pinned Flask

```text
$ bun run scripts/verify-task-a.mjs
TASK_A_OK unreviewed-refused reviewed-applied=2
  FLASK_DEBUG={"0":"False","1":"True","off":"False","n":"False","OFF":"False",
               "N":"False","false":"False","no":"False","yes":"True"}
  undo=byte-exact
$ cd forge-demo/flask && git status --porcelain -> (empty; only .DS_Store untracked)
```

This runs the real `editor_propose_edit` MCP handler and the real review registry:
an unreviewed proposal is refused and writes nothing; a reviewed proposal applies exactly
two hunks; the edited function behaves correctly for all documented values; undo restores
the original bytes.

### 3.3 Task B — real agent loop, real model, real files (end to end)

Integration path: `TrueForgeSessionHost` (extension code) → TrueForge server (real
`opencode-free-models/deepseek-v41-flash-free`) → Forge MCP server on loopback → editor
tools → the real Flask checkout. The only automated step is the human approval click:
the driver records per-hunk decisions exactly as `ForgeHunkReview` does, then approves.

```text
session               01m7rch35ycca17sbrh2x13v3h
finishReason          completed          (not aborted, not error)
wall clock            848 s
approvals             49  (12 propose_edit, 36 run_command, 1 undo)
proposals             cli.py(3) test_cli.py(1,2,2) docs/cli.rst(1) docs/api.rst(1)
                      cli.py(1,1) CHANGES.rst(1) cli.py(1) test_cli.py(2) cli.py(1)
changed files (git)   src/flask/cli.py, tests/test_cli.py, docs/cli.rst, docs/api.rst
diffstat              4 files changed, 118 insertions(+)
pytest tests/test_cli.py -q -> 58 passed, 3 skipped   (clean baseline: 55 passed, 3 skipped)
.venv/bin/flask --help     -> "config  Show the config of the app as JSON."
.venv/bin/flask --app /tmp/maskdemo.py config
  SECRET_KEY=***  DB_PASSWORD=***  API_TOKEN=***  SOME_KEY=***  NORMAL=visible
```

No file names or solution were given to the agent and none are hardcoded in retrieval.
The agent found the files through `editor_repo_map` / `editor_retrieve` / `editor_search`,
ran the suite itself, discovered the pre-existing failures, and confirmed them with
`git stash`. Evidence: `report/evidence/taskB-evidence.json`, `report/evidence/taskB.patch`.

### 3.4 Task C — resilience (real TrueForge)

Temporary providers were created for the test and deleted afterwards; the working provider
was never modified. Evidence: `report/evidence/taskC-evidence.json`,
`report/evidence/taskC-http-errors-evidence.json`.

| Scenario | Observed | Workspace |
|---|---|---|
| Unreachable primary (`127.0.0.1:9`), fallback also down | `[Forge] … unavailable (Cannot connect to API: bad port); failing over to local-ollama/…` then one error naming **both** models. TF session model after failover: `local-ollama/qwen-coder-local` (the fallback really changed). | unchanged (status + diff hash identical) |
| Cancel during retry backoff | send returned in **45 ms**, `finishReason=completed`, no model error | unchanged |
| HTTP 429 | retried twice with backoff (400/800 ms), then a clear terminal error | unchanged |
| HTTP 500 | immediate clean error, no retry (500 is treated as deterministic) | unchanged |
| Invalid key / HTTP 401 | immediate clean error, no retry, failover path offered | unchanged |

### 3.5 Context assembly evidence (pinned Flask)

```text
$ bun -e '… callEditorTool("editor_retrieve", {query, limit:6, budget_tokens:4000}) …'
QUERY: built-in CLI command that prints application config as JSON masking secrets
retrieval budget: 2220/4000 tokens across 6 chunk(s) from 12 candidate(s)
dropped 6 candidate(s) to stay inside the budget:
- src/flask/blueprints.py:41-80 — chunk cap reached
- docs/config.rst:121-160 — chunk cap reached
- docs/cli.rst:521-557 — chunk cap reached
- tests/test_json.py:1-40 — chunk cap reached
- docs/config.rst:41-80 — chunk cap reached
- CHANGES.rst:521-560 — chunk cap reached
## tests/test_cli.py:641-680 (matches "cli","command","application" · BM25 41.37 · 336 tok)
```

Ranking for `add a new flask CLI command` puts `src/flask/cli.py` at #1 (score 46.43).
Token figures are **estimates** (`ceil(chars / 3.6)`), not a tokenizer — the report says so
and the audit does not claim true token counts.

---

## 4. Critical defects found and fixed

### D1 — Interactive edit could bypass diff review entirely (CRITICAL, closed)
Two independent causes:
1. `isToolAutoApproved` returned `true` for every MCP tool when the “Use MCP servers”
   toggle was on, including `editor_propose_edit`.
2. `takeHunkDecisions` returned `[true, true, …]` whenever no review was recorded.

Together, an auto-approved proposal reached disk with no diff ever shown. Fixed:
- `isForgeWriteTool` is checked first and returns `false` (never auto-approve
  `editor_propose_edit` / `editor_undo_last_edit`).
- `takeHunkDecisions` now returns `{kind:"unreviewed", reason}`; the write path refuses
  and returns `status:"unreviewed"` without touching the file.
- An explicit `allowUnreviewedEdits(true)` seam exists only for automated tests; the
  extension never calls it.

Tests: `sdk-tool-policies.test.ts` (write tools not auto-approved even with `useMcp`),
`write-gate.test.ts`, `hunk-review.test.ts`.

### D2 — Every real edit was refused because approval input was empty (CRITICAL, closed)
TrueForge streams a tool call as one delta that carries the id and name, then many deltas
carrying only `function.arguments` fragments and an `index`. `trackToolCall` ignored the
fragment deltas, so the tracked arguments stayed `""` and the approval review received `{}`.
The fail-closed gate then refused every edit (previously this was silently masked by D1's
accept-all default). Fixed by accumulating fragments by index. Verified with a real model
turn and a unit test (`approval-stream.test.ts`) that feeds the exact event sequence.

### D3 — A review could outlive a denied approval (HIGH, closed)
A review recorded before the approval buttons were shown survived a “Reject”, so an
identical later proposal could consume it without a new review. Reviews are now bound to
the tool-call id (`recordHunkDecisions(key, accepted, toolCallId)`), dropped on denial
(`clearHunkDecisionForToolCall`), and cleared when a review cannot be shown.

### D4 — Cancellation was unsafe or misreported (HIGH, closed)
- An approval granted after the user cancelled was forwarded to TrueForge as `allow`; it
  is now forwarded as `deny` with a `cancelled` reason.
- An aborted stream surfaced as `[Model Error] … Retry`, i.e. a failed task instead of a
  cancelled one; it is now reported as an abort with no error event.
- `abort` awaited the harness cancel request, which was observed to hang for 30 s; it is
  now bounded at 2 s and the turn stops locally on the flag. Measured 45 ms in the real run.

### D5 — `@file:line-range` never carried its range (MEDIUM, closed)
The mention regex excluded `:`, so `@tests/test_cli.py:40-80` resolved the whole file.
The token now includes the range and `resolveMentionContext` slices exactly those lines
(`mention-context.test.ts`).

### D6 — Undo could clobber a newer edit (MEDIUM, closed)
`editor_undo_last_edit` blindly wrote the pre-image. It now refuses (`status:"stale"`) if
the file changed after the edit. Verified by test.

### D7 — Retrieval ranked prose above the implementing module (MEDIUM, closed)
Filler words (`as`, `in`, `that`, `add`, `new`) carried BM25 weight and a prose-heavy file
could outrank `cli.py`. Stopword filtering plus a small path-relevance boost fixed the
ordering (`retrieval.test.ts`).

### D8 — Broken/absent gate scripts and stale docs (LOW, closed)
`GATES.md` referenced `.unlazy/verify/writeup.mjs` and `demo-script.mjs`, which did not
exist. Both were added and pass. README's “19 files” (actually 43), the fallback model name
(`jev-113-free` vs the committed `local-ollama/qwen-coder-local`), the approval list, the
write-up's “59 passed” (actually 58/3 skipped), “82 tests” (actually 127 trueforge tests),
and the “no review ⇒ all accepted” claim were all corrected. `report/forge-writeup.pdf`
was regenerated from the corrected HTML.

---

## 5. Real editor-level verification: what was and was not done

**Executed against real processes and real files**
- Real TrueForge server (v0.185.1) with a real model turn.
- Real `TrueForgeSessionHost`, real session creation, streaming, tool approvals, cancel.
- Real Forge MCP server on loopback and all eight tools enumerated by a real MCP
  `tools/list` (a live VS Code extension host is listening on 127.0.0.1:8791).
- Real writes to the pinned Flask checkout, real `pytest`, real `flask --help`,
  real `flask config` JSON with masking.

**Not executed (and therefore not claimed as verified UI behaviour)**
- Clicking the `vscode.diff` tab and the per-hunk *Keep/Skip* modal in a live window.
- The `Cmd/Ctrl+Alt+K` inline-edit keybinding end to end.
- Watching tokens render in the Cline webview during the demo.
- Live context-compaction events (the handler is implemented and the trigger is configured
  at 120k input tokens, but the run did not cross it).

These are code-verified and unit-tested (`ForgeHunkReview.ts`, `ForgeInlineEdit.ts`,
`context-budget.test.ts`), and the write contract beneath them is proven. They still need
one on-camera rehearsal before the video is recorded.

---

## 6. Known limitations

1. **Retrieval is lexical.** BM25 over ~40-line chunks with stopword filtering and path
   boosts. It is deterministic and explainable, but it is not semantic; a task whose
   wording shares no tokens with the implementation would rank poorly.
2. **Token counts are estimates** (`chars / 3.6`), not tokenizer output.
3. **Undo is whole-proposal and LIFO.** It now refuses if the file changed, but it cannot
   restore a single hunk from a multi-hunk proposal.
4. **Approval UI is the chat + modal.** There is no inline hunk checkbox in the diff tab;
   decisions are collected one modal at a time.
5. **The local fallback needs Ollama.** With no daemon the automatic fallback cannot
   answer; the exhausted path reports both models clearly.
6. **`500` is not retried** (only 429/502/503/504 and transport errors). Deliberate, but a
   transient 500 will fail over rather than back off.
7. **Loopback MCP has a shared token, not full auth.** Fine for a single-user local demo.
8. **`edit-registry.ts` is unused dead code.** The live path is `hunk-review.ts` +
   `editor_propose_edit`; the dead module's docstring describes a staging design that is
   not the one implemented. It should be deleted or wired in.
9. **Video, public push and portal submission are not done.**

---

## 7. Remaining user actions

1. Record the ≤ 4:00 video: Task A (diff + two hunks accepted, `FLASK_DEBUG=off` → False),
   Task B (agent discovers files, approves, pytest 58 passed / 3 skipped, `flask --help`,
   masked JSON), Task C (break the endpoint, show retry/failover and the clean error,
   `git status` empty, restore). Fill the `TBD` timestamps in the write-up.
2. Push the repo to a public GitHub URL and replace `github.com/<owner>/<repo>` in the
   write-up cover, then regenerate the PDF.
3. Start `ollama serve` with `qwen2.5-coder:1.5b` before the recording if the automatic
   fallback should visibly succeed; otherwise record the honest "all models failed" path.
4. Submit the portal entry. (Not done here by instruction.)
5. Optional cleanup: delete the unused `apps/vscode/src/trueforge/edit-registry.ts`.

---

## 8. Changed files and commits (this audit)

Code: `hunk-review.ts`, `mcp/tools.ts`, `mcp/server.ts`, `trueforge-session-host.ts`,
`mentions.ts`, `retrieval.ts`, `model-fallback.ts`, `ForgeHunkReview.ts`,
`SdkController.ts`, `sdk-tool-policies.ts`.

Tests added: `write-gate.test.ts`, `approval-stream.test.ts`, `cancel-backoff.test.ts`,
`retrieval.test.ts`, `mention-context.test.ts`; extended `hunk-review.test.ts`,
`mentions.test.ts`, `sdk-tool-policies.test.ts`.

Gates/tools: `.unlazy/verify/writeup.mjs`, `.unlazy/verify/demo-script.mjs`,
`scripts/verify-task-a.mjs`.

Docs: `README.md`, `GATES.md`, `report/demo-script.md`, `report/forge-writeup.html`,
`report/forge-writeup.pdf`, this report, `report/evidence/`.

Commits added by this audit:

```text
afa8fc7 fix(forge): fail closed without a hunk review; never auto-approve write tools
38d87e8 fix(forge): resolve streamed approval input and make cancellation safe
eb2556c fix(forge): honour @file:line-range mentions
cff0d2f feat(forge): filter query filler and boost path relevance in retrieval
f938c42 docs(forge): describe the write tool as it behaves; expose retrieval budget
c319dfe docs(forge): correct the submission facts and add the independent audit
```

The working tree is clean after these commits; Flask is pristine at `22d92470` / `3.1.3`.
