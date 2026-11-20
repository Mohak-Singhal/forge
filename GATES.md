# Gates: Forge-a-thon Round 1 build (solo mode)

OWNS: .

Scope: a working fork of Cline in this repo whose agent loop runs on TrueForge
(loopback MCP tools, approval-gated per-hunk writes, streaming, cancel, second-model
resilience), plus the Round 1 submission documents (README, write-up PDF with the
8 required headings, demo script, runbook). Video recording and portal submission
are explicitly OUT of scope until the user asks.

Deadline context: Round 1 artefacts due 2026-11-20 23:59 IST. Documents are drafted
from real measured results, never from invented ones.

- [x] G1: Repository contains the fork at the declared upstream commit with upstream LICENSE preserved
  CHECK: node .unlazy/verify/fork-point.mjs
  EXPECT: FORK_POINT_OK  (2026-11-18, eff43e19b)

- [x] G2: TrueForge local server answers on localhost:8790
  CHECK: node .unlazy/verify/trueforge-up.mjs
  EXPECT: TRUEFORGE_UP  (2026-11-18)

- [x] G3: Two OpenAI-compatible models are configured in TrueForge and both answer a smoke turn
  STATUS: both answer as of 2026-11-19 06:05 after starting `ollama serve`; model qwen2.5-coder:1.5b present locally.
  CHECK: node .unlazy/verify/smoke-models.mjs
  EXPECT: SMOKE_OK  (2 models answered: opencode-free-models/deepseek-v41-flash-free, local-ollama/qwen-coder-local)

- [x] G4: The extension compiles/builds cleanly from this repo
  CHECK: node .unlazy/verify/build.mjs
  EXPECT: BUILD_OK  (2026-11-19 06:20: BUILD_OK extension.js=26274500B webview=ok)

- [x] G5: The extension's loopback MCP server exposes the editor_* tools and they pass unit tests
  CHECK: node .unlazy/verify/mcp-tools.mjs
  EXPECT: MCP_TOOLS_OK  (8 tools incl. editor_undo_last_edit, 2026-11-18)

- [x] G6: End-to-end deny path leaves the workspace byte-identical; accept path applies hunks and is undoable
  CHECK: bun run scripts/verify-task-a.mjs
  EXPECT: TASK_A_OK  (2026-11-19: unreviewed refused, 2 hunks applied, undo byte-exact)
  ALSO: bunx vitest run --config apps/vscode/vitest.config.ts src/trueforge/write-gate.test.ts

- [x] G7: Task A rehearsal on the flask 3.1.3 checkout prints False with FLASK_DEBUG=off after accepting the proposed edit
  CHECK: bun run scripts/verify-task-a.mjs
  EXPECT: TASK_A_OK  (off/n/OFF/N/0/false/no -> False; 1/yes -> True; undo restores exact bytes)

- [x] G8: Write-up PDF exists with the 8 required headings in order
  CHECK: node .unlazy/verify/writeup.mjs
  EXPECT: WRITEUP_OK

- [x] G9: README documents fork point, quickstart, models, test command; no secrets anywhere in the tree
  CHECK: node .unlazy/verify/hygiene.mjs
  EXPECT: HYGIENE_OK  (git grep on tree + strict pass on fork delta; all flagged lines are upstream gitleaks:allow fixtures)

- [x] G10: Demo script exists and records the exact commands for Tasks A/B/C verifications
  CHECK: node .unlazy/verify/demo-script.mjs
  EXPECT: DEMO_SCRIPT_OK

## 2026-11-18 session addendum
- Task B verified end-to-end: agent-discovered edits to src/flask/cli.py, tests/test_cli.py, docs/cli.rst, docs/api.rst; pytest tests/test_cli.py -q -> 58 passed; flask --help lists config; masked JSON (SECRET_KEY etc. -> ***); flask repo now PRISTINE (git checkout -- .) for the video rehearsal; full A+B diff backed up to forge-logs/flask-taskA-B-backup2.patch
- Task C verified: provider base_url -> 127.0.0.1:9; TF turn ended state=error (Cannot connect to API: bad port); extension renders [Model Error] ... with Retry / Start New Task (host fix committed); git status clean; provider restored afterwards
- A3 verified: Cancel mid-run -> TF records client-cancelled (8168 in / 191 out); workspace porcelain empty
- B2 verified: editor_undo_last_edit round-trip via MCP (propose -> applied -> file changed; undo -> original bytes); approval-gated
- G6 (approval roundtrip): stale-hunk reject leaves file byte-identical (sha256 bce2aeea before/after); accept path verified repeatedly
- build verified from a CLEAN CLONE: bun install -> bun run build:sdk -> cd apps/vscode && bun run package (check-types + lint + prod build) exits 0 on forge branch
- biome lint: clean (apps/vscode/src/trueforge/*)
- write-up PDF: report/forge-writeup.pdf (3 pages, 8 headings); placeholders: video timestamps + college/employer
- unpushed commits: all local on branch forge (~18 commits); flask demo repo is detached at 3.1.3, working tree pristine
- pending: video recording (needs screen+mic consent and upload to public link), GitHub public push (needs approval + repo name), portal submission, team details for PDF

## Dry run 2026-11-18 (single continuous sitting, open -a Visual Studio Code.app)
- Task A: agent (deepseek-v41-flash-free) read helpers.py + test_helpers.py, proposed 1-hunk edit, applied after Approve; FLASK_DEBUG off/OFF/n/N/0/False/no/''->False, yes/true/1->True; 6 passed; diagnostics clean; DONE status done; ~2:00
- Task B: agent read cli.py/cli.rst/test_cli.py/api.rst/CHANGES.rst WITHOUT file hints; proposed cli.py (3 edits, applied), test_cli.py (applied, then self-corrected a missing `import json` in a follow-up edit — applied), docs/cli.rst + docs/api.rst (2 docs, applied); agent added 4 tests (JSON round-trip, masking incl. SECRET_KEY_FALLBACKS/PRIVATE_KEY_PATH, non-serializable value, help listing) -> tests/test_cli.py -q: 59 passed 3 skipped (async extra pre-existing skip); full suite: 479 passed, 2 failed (BOTH pre-existing on pinned tag: async extra + test_bad_environ_raises_bad_request 404==400 — verified via git stash on pristine tag); agent self-verified the 2 failures are pre-existing; `flask --help` lists config; `flask config` shows SECRET_KEY/***; agent's diff --stat: 5 files, 128 insertions
- Task C: stash A+B -> base_url->127.0.0.1:9 -> repeat Task A instruction -> turn ends state=error "[Model Error] Cannot connect to API: bad port" in ~2s; chat renders message + Retry / Start New Task; git status empty; provider restored (backup PUT verified)
- flask tree: pristine at 3.1.3; stash@{0} "round1 rehearsal A+B" holds the rehearsal diff (kept for reference; safe to drop)
- ego lite parked on http://localhost:8790/sessions (emulated desktop viewport 1320x660@dpr2) showing the Task B session; agent workspace restored; TF provider restored to gateway
- remaining: user records video (QuickTime/screen recorder), uploads to public link; user pushes repo; user submits portal; scorecard video timestamps filled after the cut

## 2026-11-18 late session — scoring gaps closed (B1 / B2 / B3 / B4)
- B1: added context-budget.ts (hard 4K-token budget, maxChunks, per-chunk compression, drop reasons, markdown report), retrieval.ts (BM25 matched terms + real repo map with def/class symbols), mentions.ts (@file / @file:40-80 / @Symbol, resolved to a non-evictable ground-truth block). editor_retrieve now returns the budget report. 15 unit tests added.
- B2: added hunk-review.ts (keyed per-hunk decisions, consumed once) + ForgeHunkReview.ts (real vscode.diff + Keep/Skip per hunk) wired into SdkController.onToolApprovalAsk. editor_propose_edit applies only accepted hunks; a stale hunk no longer discards the rest. 7 unit tests added. Previously editor_propose_edit opened no diff at all.
- B3: added retry-with-backoff (400/800/1600/3200, transient errors only), turn.done state=error/failed now drives the failure path, injectable sleep, and client.switchModel() re-points inline sessions. Registered local-ollama/qwen-coder-local (qwen2.5-coder:1.5b, 127.0.0.1:11434/v1) as the real second model; spec fallbacks updated. 8 unit tests added.
- B3 LIVE PROOF: bun run scripts/verify-fallback.mjs -> primary base_url=127.0.0.1:9 -> "[Model Error] Cannot connect to API: bad port" -> decideFallback next=local-ollama/qwen-coder-local -> session re-pointed=true -> fallback text "PONG", error empty -> FALLBACK_OK -> both providers restored. The probe omits mcp_servers because port 8791 is only served by the VS Code dev host; model failover is what is under test.
- B4: TF compaction now has an explicit input_tokens trigger (120000) and its thread.context_compaction_started/finished events are surfaced as transcript notes with token count, threshold and duration. TF echoed the full config (compaction + large_tool_response + dynamic_sub_agents) on session create (session 01m7qwcyhhe7jy6a8hhdpbq0q6).
- Verification after the changes: apps/vscode/src/trueforge vitest 82 passed; bun run test:unit 1244 passed / 0 failed; tsc --project tsconfig.vscode-compat.json clean; biome 0 errors; bun esbuild.mjs rebuilt dist/extension.js (23:27).
- Write-up regenerated: report/forge-writeup.pdf 3 pages, 8 headings in order, 58 -> 59 passed corrected, B3 claim upgraded to automatic fallback, new retrieval-budget and review prose.
- Remaining: on-screen re-verification of the new diff UX (A/B), video, GitHub push, portal submission.

## 2026-11-19 late session — diff-review runtime fix
- On-screen Task A attempt exposed a real B2 bug: TrueForge's `tool.approval_required` event carries tool-call IDs but an EMPTY `input` object. `handleToolApproval` therefore never parsed the tracked `model.message` arguments, so `reviewForgeProposal` saw no path/hunks and silently fell through to a bare Approve button — no diff tab, no per-hunk review.
- Fix: extracted pure `resolveApprovalInput(callInput, trackedArguments)`; when the approval input is empty/absent it parses the tracked JSON arguments. 7 unit tests added (empty input, absent input, populated input wins, invalid JSON, null).
- Real gateway error observed during the same run: `[Model Error] Request failed (200): ... Body Timeout Error`. Added `body timeout` / `request failed` to both `isModelUnavailableError` and `isRetryableError` so backoff and failover engage; regression test added.
- Verification: 90 trueforge vitest tests pass; tsc clean; biome clean; bun run test:unit 1244 pass / 0 fail; bundle rebuilt; commits 2c16e7c and ff29b58.
- BLOCKED on on-screen re-verification of the diff UX: the local automation environment repeatedly kills both the TrueForge process and the VS Code dev-host window, and the free gateway intermittently times out mid-turn (Body Timeout Error). The code path is now unit-tested and typechecked; a clean GUI rehearsal is still needed before recording the video.


## 2026-11-19 independent audit — critical defects found and fixed
- DRIFT: HEAD was 91d2ecc (docs commit), not the brief's expected 2c16e7c. 2c16e7c is an ancestor; the uncommitted tree already carried a partial fail-closed change.
- CRITICAL (silent-write bypass, closed): with "Use MCP servers" auto-approval on, `vscode-editor-tools__editor_propose_edit` was auto-approved and `takeHunkDecisions` defaulted missing reviews to all-true. An edit could reach disk without any diff review. Now write tools are never auto-approved (`isForgeWriteTool`), `takeHunkDecisions` returns `{kind:"unreviewed"}` instead of implicit consent, and the tool refuses with `status:"unreviewed"` unless an explicit headless seam is enabled.
- CRITICAL (would have blocked every real edit): TrueForge streams a tool call as one delta with the id plus many argument fragments with only an `index`. `trackToolCall` ignored the fragments, so approval input was `{}` and the fail-closed tool refused everything. Fixed by accumulating fragments by index; the review now receives `{path, summary, edits}`.
- CRITICAL (stale review reuse): a review recorded before a denied approval could be consumed by a later identical proposal. Reviews are now bound to the tool-call id and dropped on denial or when the diff cannot be shown.
- Cancellation: an approval granted after the user cancelled is forwarded as a denial; a stream aborted by the user is reported as abort, not `[Model Error]`; `abort` is bounded (2s) so a hung harness cancel cannot hold the spinner; cancel during retry backoff returns in 45ms.
- Mentions: `@file.py:40-80` never carried its range (the regex excluded `:`), so the whole file was resolved. The range is now parsed and sliced exactly.
- Undo: refuses to overwrite a file that changed after the edit (was a blind byte restore).
- Retrieval: stopword filtering + path-relevance boost; `cli.py` now ranks above prose files for Task-B-style queries (regression tests).
- Gates: added the missing `.unlazy/verify/writeup.mjs` and `demo-script.mjs` (referenced but absent) and `scripts/verify-task-a.mjs`.
- Verification: 1680 vitest tests pass (116 files), 1244 bun unit tests pass, `tsc --noEmit` clean, production `bun run package` BUILD_OK (extension.js 26,273,802 B).
- E2E Task B through the real host + TF + MCP: session 01m7rch35ycca17sbrh2x13v3h, 49 approvals, 4 files +118 lines, pytest 58 passed/3 skipped, `flask --help` lists config, masked JSON verified.
- Remaining: no video; GitHub push and portal submission out of scope; the VS Code diff-tab UI itself still needs one on-camera rehearsal.

## 2026-11-19 recording-readiness session — real UI verification
- Real VS Code dev host (Extension Development Host, PID 61223) drove Task A through the actual editor UI: Quick Open -> `helpers.py`, Ctrl+G to line 28, select `get_debug_flag`, `cmd+alt+k`, submit the exact competition instruction. A real `vscode.diff` tab opened (`Forge inline edit: src/flask/helpers.py (N hunks)`) with a per-hunk modal.
- Per-hunk independence proved on a 2-hunk proposal: accepted Hunk 1/2 (FLASK_DEBUG false-set), rejected Hunk 2/2 (docstring reword); only hunk 1 landed. Reject path on a 1-hunk proposal left the file byte-identical (sha256 unchanged) and `git status` empty.
- Undo: `cmd+alt+z` (with the file's own tab focused) and the Command Palette both restored the exact original sha256 `ac96607b...`; `git status` clean after every cycle. First `cmd+alt+z` attempt did nothing because the diff tab was focused — operator note for the demo: click the file tab first.
- Cancellation consistency: modal Cancel and Escape in the instruction box both left no write and no new tab; file sha256 unchanged, tree clean.
- Ollama started (`ollama serve`, qwen2.5-coder:1.5b); `smoke-models.mjs` -> SMOKE_OK for both models.
- Live failover: temporary `badendpoint/dead-model` (127.0.0.1:9) as primary, local-ollama fallback -> failover note naming both models, session model switched to `local-ollama/qwen-coder-local`, real answer `pong`, workspace unchanged, temp provider deleted, both original providers restored, agent spec byte-identical.
- NEW DEFECT 1 (fixed): inline edit trusted `window.activeTextEditor`; with a `cline-edit-preview` diff tab active it captured the preview text/path, so the model reasoned about non-file content. Reproduced on camera in the dev host.
- NEW DEFECT 2 (fixed): request content was captured before the model call and applied after review with no drift check, so a mid-turn edit could be overwritten.
- Fix: pure `inlineEditDocumentRejection` + `hasDocumentDrifted` guards (checked before the prompt and before writing), 7 new unit tests, commit bda6404. Live re-check: untitled buffer refused with a warning before the input box; active Forge diff tab refused with "this is a diff or preview tab, not a file"; normal accept path still applied, then undo restored exact bytes.
- Verification: 1687 vitest tests pass (116 files), 1244 bun unit tests pass, `tsc --noEmit -p apps/vscode` clean, biome clean, G4 BUILD_OK. Flask demo repo pristine at 22d92470.
