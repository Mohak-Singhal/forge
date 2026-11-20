# Forge — Technical Depth 45: Independent Verification and Targeted Improvements

Date: 2026-11-19 · Branch `forge` · Start HEAD `f075294` · Demo repo
`/Users/mohaksinghal/Documents/GitHub/forge-demo/flask` at `22d92470` (Flask 3.1.3)

This audit covers the four technical-depth criteria only: **B1 context assembly (15)**,
**B2 diff safety (10)**, **B3 resilience (10)** and **B4 TrueForge integration depth (10)**.
Scores are not asserted; each section states the highest anchor requirement that was
directly demonstrated, with the evidence and the remaining gap. The rubric's own
anchors decide the number.

---

## 0. What changed in this pass

| Change | Why | Commit |
| --- | --- | --- |
| `retrieveContext` in `retrieval.ts`: symbol-link expansion + role quota + per-file caps | Measured failure: Task B retrieval surfaced **1 of 4** essential files | `59136ce` |
| Report header (query, intent) + `selectedFrom` + link reasons in `context-budget.ts` | The model must see *why* each chunk was chosen, not just the text | `59136ce` |
| `editor_retrieve` default 8 slots, uses the plan | 6 slots left 1.5k of a 4k budget unused and starved tests/docs | `59136ce` |
| `applyHunks` identifier-boundary matching in `edits.ts` | Adversarial test found `VALUE = 1` matching inside `VALUE = 10` | `59136ce` |
| 13 adversarial write tests + 6 hunk-boundary tests + 4 retrieval/budget tests | Regression coverage for the above | `59136ce` |
| Fallback list updated to tool-capable local models | The previous fallback could not call tools (see B3) | pending |

Nothing in the existing per-hunk review UI, approval flow, or TrueForge authority was
rewritten. The production compaction threshold (120,000) is unchanged.

---

## A. Four-criterion scorecard

| Criterion | Highest anchor directly demonstrated | Evidence | Real execution method | Remaining uncertainty / missing proof |
| --- | --- | --- | --- | --- |
| **B1 Context assembly (15)** | Retrieval selects implementation + test + docs under a stated budget, explains each pick and each exclusion, and the model demonstrably uses the report | 4/4 essential files, 2938/4000 tokens, 42 candidates ranked, link reasons in the tool result; real session `01m7scj4wtb5qxdbjd2gd65sa1` | Production `retrieveContext` + `packContext` on pristine Flask; real TrueForge session with the exact Task B instruction | Lexical only: a doc that shares no vocabulary with the task can still be missed (doc-only control). Token counts are estimates (chars/3.6), not provider counters for the retrieval payload itself. |
| **B2 Diff safety (10)** | Fail-closed: no write without an applicable review; per-hunk apply; byte-exact undo; adversarial cases refuse and preserve bytes | 13 adversarial tests + 6 boundary tests pass; real UI accept/reject/undo from `FINAL_RECORDING_READINESS.md` | `callEditorTool` against temp workspaces; real VS Code per-hunk modal and `cmd+alt+z` | Duplicate tool-call IDs are not visible at the MCP boundary; the review is keyed by content and consumed once. Overlapping hunks are applied sequentially and the second is refused. No in-diff checkboxes (modal is the control). |
| **B3 Resilience (10)** | Automatic switch to the configured fallback with a visible note, session re-pointed, workspace unchanged, providers restored | Failover note, `sessionModel = local-ollama/…`, 4.2 s, real `pong`; Task C harness | Real host → TrueForge → unreachable primary (`127.0.0.1:9`) → Ollama | **Exact Task C (fallback completes the Task A edit) is the open question.** Small local models tested so far answer in text instead of calling tools (see §C). |
| **B4 TrueForge integration depth (10)** | TrueForge owns sessions/turns and tool calls; MCP execs editor actions; TF approval drives the diff; compaction observed in a real session; write-up documents it | Session events with `tool_calls`, `tool.response`, `tool.approval_required`; 7 compaction cycles; 907-token schema measurement | Real sessions through `TrueForgeSessionHost`; session events API | Compaction was demonstrated at a reduced 2,500-token threshold, not the 120k production threshold (a production Task B turn does not cross 120k). Subagents and skills are configured/not configured but not invoked. |

---

## B. Retrieval report (before / after)

### Setup

- Repository: pristine `flask` at `22d92470` (no files changed during measurement).
- Query: the exact Task B instruction, with **no filenames mentioned**.
- Ground truth (chosen before measuring): `src/flask/cli.py`, `tests/test_cli.py`,
  `docs/cli.rst`, `docs/api.rst`; secondary `src/flask/config.py`, `tests/test_basic.py`,
  `CHANGES.rst`.
- Before = `retrieveCode` + `packContext(maxChunks: 6)` (the previous tool behavior).
- After = `retrieveContext(maxChunks: 8)` + `packContext` (current tool behavior).

### Measured result

| Metric | Before | After |
| --- | --- | --- |
| Essential-file recall | **1/4** (`cli.py`) | **4/4** |
| Files in context | cli.py, config.py, test_basic.py | cli.py, config.py, test_basic.py, tests/test_cli.py, docs/cli.rst, docs/api.rst |
| Chunks selected / candidates ranked | 6 / 12 | 8 / 42 |
| Token budget | 2479 / 4000 | 2938 / 4000 |
| Essential-chunk precision | 4/6 | 6/8 |
| Latency | 80–140 ms | 40–100 ms |
| Identical across repeated runs | yes | yes |

The after-set is exactly the four files a correct Task B change touches, plus two
legitimately related files (the `Config` class and the existing config-masking tests in
`test_basic.py`). No filenames or repository-specific paths are in the code: the extra
files come from symbol references and from the task's explicit “test”/“documented” ask.

### Why the old ranking missed them

`docs/api.rst` was not in the top 40 BM25 chunks at all; `docs/cli.rst` ranked 31st and
`tests/test_cli.py` 12th. Prose `.rst` has low term density, and `cli.py` occupied half
the six slots. The old report could not explain a document it never ranked.

### What the improvement does (generic, no repository names)

1. BM25 ranks the candidate pool (unchanged).
2. The strongest implementation chunks contribute `def`/`class` symbols, filtered by
   document frequency (≤ 10 files) so generic names do not link the whole repo.
3. Any file that references two or more of those symbols gets a candidate window around
   its densest reference; its score is set relative to the defining chunk (more linked
   symbols → closer to the source, never above it). This is what finds imports in tests
   and `autoclass`/`:func:` entries in docs.
4. Selection keeps the top 3 chunks, guarantees a test chunk and up to two doc files when
   the task asks for them, prefers linked test/doc files over merely word-matching ones,
   and caps chunks per file (2, or 3 for the top-ranked file being edited).
5. The tool result starts with the query and detected intent, then the budget and
   `selected from 42 candidate(s)`, then every chunk with its reason — including
   `links to with_appcontext, load_dotenv, FlaskGroup` for doc chunks.

### Controls

| Query | Before | After |
| --- | --- | --- |
| “Add a test for get_debug_flag parsing the FLASK_DEBUG environment variable” | 2/2 recall, 1667 tokens | 2/2 recall, 2412 tokens |
| “Document the --app option for the flask command” | 1/2 recall (docs/cli.rst missed) | 1/2 recall (still missed) |

The test control keeps recall but spends ~745 extra tokens on link-related chunks
(`src/flask/testing.py`, `src/flask/app.py`). The doc-only control shows the honest limit:
without shared vocabulary the link symbols come from the wrong seed, so a follow-up
`editor_search`/`editor_read_file` is still needed. The headline win is the Task B
workflow, not every possible query.

### Bounds and exact reads

| Tool | Default | Measured |
| --- | --- | --- |
| `editor_read_file` | 398 lines | cli.py lines 1–398 → 14,163 chars ≈ 3,935 est. tokens; explicit 520–560 → 2,011 chars ≈ 559 tokens |
| `editor_search` | 50 matches | 4,782 chars ≈ 1,329 tokens; `limit: 20` → 2,552 chars ≈ 709 tokens |
| `editor_retrieve` | 8 chunks / 4,000 tokens | 2,938 tokens, 8 chunks, 42 ranked |

### Visible in the real session

Session `01m7scj4wtb5qxdbjd2gd65sa1` (real TrueForge, real model, real MCP):

- `model.message` → `tool_calls: [editor_retrieve]`, `finish_reason: "tool_calls"`.
- Usage breakdown: `input_tokens 3190 = harness 1302 + instructions 463 + tool_definitions 783 + messages 642`.
- `tool.response` carries the full report: `query: … · intent: tests+docs`,
  `retrieval budget: 2938/4000 tokens across 8 chunk(s), selected from 42 candidate(s)`.
- The model's next message explains each selected file and explicitly flags a gap
  (“Only matched on SECRET/KEY/json tokens … not actually the right test home” for
  `tests/test_basic.py`) and what it would read next. That is the selection information
  being used, not just displayed.

Evidence: `report/evidence/technical-depth/b1-*.json|txt`.

---

## C. Resilience (B3)

### What is proven

- Primary `badendpoint/dead-model` (closed port `127.0.0.1:9`) fails with
  `[Model Error] Cannot connect to API: bad port`.
- The host emits one visible note naming both models:
  `[Forge] badendpoint/dead-model unavailable (…); failing over to local-ollama/…`.
- The TrueForge session is re-pointed: `sessionModel.name` becomes the fallback.
- A real answer comes back from the fallback (`pong`, `finishReason: completed`, 4.2 s).
- The workspace is unchanged and the temporary provider is deleted; both original
  providers and the agent spec are restored byte-identically.
- Cancel during retry backoff returns in 45 ms; a 429 retries twice then errors cleanly;
  500/401 produce clean errors (prior audit, unchanged).

### The open question: can the fallback complete Task C?

Switching a model is not the same as completing the Task A workflow. Two local
candidates were tested end-to-end through the real host:

| Fallback | Native tool calls (direct) | Through TrueForge | Result |
| --- | --- | --- | --- |
| `qwen2.5-coder:1.5b` | **no** — returns JSON in text | no tool calls | answers text, no proposal |
| `llama3.2:1b` | yes (OpenAI endpoint) | **no** — hallucinated a function list | no proposal |
| `llama3.2:3b` | yes (OpenAI endpoint) | **no** — one text JSON object | no proposal |
| `qwen2.5-coder:7b` | test in progress | test in progress | — |

The TrueForge request does include tools (session usage shows `tool_definitions: 793`
tokens), so this is model behaviour under the real agent prompt, not missing schemas.
The 1–3B models choose to write JSON instead of using the tool-call interface.

**Status:** fallback switching = **PASS**; exact Task C (fallback produces an approved
proposal and edits the file) = **not yet demonstrated**. The final result with the 7B
model is recorded in §C.2 below.

### C.2 Final Task C result

_(filled after the 7B run)_

---

## D. TrueForge feature report

| Feature | Configured | Observed in a real session | Useful to the agent | Notes |
| --- | --- | --- | --- | --- |
| Sessions/turns owned by TrueForge | yes | yes — `turn.created`, `model.message`, `tool.response` in the session API | yes | The extension only renders events; no second loop |
| MCP editor tools | yes (`preload: true`, 8 tools) | yes — `editor_retrieve`, `editor_read_file`, `editor_propose_edit` calls recorded | yes | 3,253 chars ≈ 907 est. tokens of schema per turn |
| TF approval driving diff review | yes (`require_approval_for_tools`) | yes — `tool.approval_required`; modal + `takeHunkDecisions` | yes | Fail-closed when no review is recorded |
| Compaction | yes (120,000 production) | yes at a test threshold of 2,500: 7 cycles, `context_tokens` 4,966 → 11,693, input tokens falling 5,786 → 3,161 | yes — final answer named `FlaskGroup.__init__`, `add_default_commands`, `tests/test_cli.py`, `docs/cli.rst` | Production threshold not crossed by a normal turn |
| `large_tool_response` | yes | config echoed by the session | not measured separately | Tool outputs are already bounded by the tools themselves |
| Dynamic subagents | yes (`dynamic_sub_agents.enabled`) | no subagent events in any session | not exercised | Configured only |
| Skills | no | no | no | Not configured |
| Code Mode | no | no | no | Not configured |
| Deferred tool loading | supported by TF, not enabled | no | trade-off measured: 907 tokens/turn saved versus one discovery round trip; with 8 tools, preloading is the better trade for reliability | Retained `preload: true` |

Architecture trace (code + events): `report/evidence/technical-depth/b4-architecture.txt`.

The extension never constructs a provider client; `forgeEngine: "trueforge"` selects
`TrueForgeSessionHost` in `sdk-session-lifecycle.ts`, and every model/tool event comes
from the TrueForge session. The write path is: TF approval → `handleToolApproval` →
`ForgeHunkReview` diff → `recordHunkDecisions` → MCP `editor_propose_edit` →
`takeHunkDecisions` → `applyHunks`.

---

## E. Safety regression results (B2)

All executed with `callEditorTool` against temp workspaces; the real UI paths are from
the recording-readiness run (hashes in `FINAL_RECORDING_READINESS.md`).

| Scenario | Result |
| --- | --- |
| No review recorded | `status: "unreviewed"`, file byte-identical |
| Review replayed for the same proposal | second call `unreviewed`, file unchanged |
| Review cleared by a denied tool call | `unreviewed`, file unchanged |
| Review length ≠ proposal length | `unreviewed`, file unchanged |
| Proposal built from a stale base | `rejected`, file unchanged |
| File edited after the review, anchor gone | `rejected`, user's newer bytes preserved |
| Overlapping hunks | first applies, overlapping second is refused, no corruption |
| Partial multi-file change | first file applied, failed file untouched |
| Undo after an unrelated later edit | `status: "stale"`, no overwrite |
| Undo with nothing else changed | byte-exact original |
| Missing `edits` / malformed hunk | throws, file unchanged |
| Path outside the workspace / empty path | refused |
| Substring anchor (`VALUE = 1` vs `VALUE = 10`) | **new**: refused after the boundary fix |
| Diff tab used as the inline-edit source | refused with a warning (previous pass) |

Tests: `adversarial-write.test.ts` (13), `edits.test.ts` (6), plus the existing
`write-gate`, `hunk-review`, `approval-stream`, `cancel-backoff` suites. 159 tests in
`src/trueforge` pass.

---

## F. Recording guide (4 minutes)

`report/TECHNICAL_DEPTH_DEMO_SHOTS.md` has the shot list. The compression:

| Time | Shot | Technical-depth anchor shown |
| --- | --- | --- |
| 0:00–1:15 | Task A: inline edit, diff tab, accept one hunk / reject another, undo | B2 per-hunk + byte-exact undo; B4 approval-driven diff |
| 1:15–2:35 | Task B: no filenames; show the retrieval report card (budget, 8/42, link reasons), then approvals and pytest | B1 context assembly; B4 MCP + TF session |
| 2:35–3:20 | TrueForge session view: tool calls, `tool.approval_required`, turn events | B4 authority + approval |
| 3:20–3:50 | Task C: break primary, failover note, session model switch; show workspace clean; restore | B3 resilience |
| 3:50–4:00 | Compaction note or session token drop (if visible) | B4 context engineering |

---

## G. Final recommendation

_(filled after the Task C fallback result)_
