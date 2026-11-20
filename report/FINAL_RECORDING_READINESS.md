# Forge — Final Recording Readiness

Date: 2026-11-19 · Scope: live UI verification and recording readiness only (no architecture
rewrites, no new features)

Branch `forge` · Start HEAD `bcf5813` · End HEAD `60fa408` (fix `bda6404`, docs `60fa408`)
Demo repo `/Users/mohaksinghal/Documents/GitHub/forge-demo/flask` pinned to `22d92470`
(Flask 3.1.3)

---

## Verdict

**READY to record.** Every beat the demo script needs was executed through the real
VS Code Extension Development Host against the real TrueForge server, and each was
checked against file bytes and `git status`, not against UI text alone. Two concrete
defects were found during the rehearsal and are fixed with regression tests and live
re-verification. Nothing below is marked PASS without an execution record.

The video itself is still **not recorded** (explicitly out of scope for this run), so the
write-up's video points stay at zero until a real recording exists.

---

## Checklist

| Requirement | Result | Evidence |
| --- | --- | --- |
| TrueForge running, extension dev host loaded | **PASS** | `TRUEFORGE_UP` on `:8790`; Extension Development Host loaded `apps/vscode` (VS Code 1.147.0), workspace `flask`, PID 61223 |
| Task A through the real editor UI | **PASS** | Quick Open → `helpers.py`, `Ctrl+G` line 28, selected `get_debug_flag` (230 chars), `cmd+alt+k`, submitted the exact competition instruction in the real Forge input box |
| Real `vscode.diff` editor opens | **PASS** | Tab `Forge inline edit: src/flask/helpers.py (1 hunk)` / `(2 hunks)`, diff rendered side by side |
| Per-hunk Keep/Skip or Accept/Reject controls | **PASS** | Per-hunk modal with `Accept Hunk` / `Reject Hunk` / `Cancel`; on a 2-hunk proposal accepted **Hunk 1/2**, rejected **Hunk 2/2**, and only hunk 1 landed |
| Accept one hunk, reject another, apply exactly that | **PASS** | After the run: `return ... {"0","false","no","off","n"}` present; `get_load_dotenv` docstring still starts with “Get whether”; SHA-256 `9e989e58…` |
| Rejected proposal does not modify files | **PASS** | Reject on a 1-hunk proposal: SHA-256 unchanged `ac96607b…`, `git status` empty |
| Undo restores original bytes | **PASS** | `cmd+alt+z` with the file tab focused and Command Palette both restored `ac96607b…` exactly, `git status` empty (after a 1-hunk accept and after the accept-1/reject-1 run) |
| Cancellation leaves no change | **PASS** | Modal `Cancel` and `Escape` in the instruction box: no write, no new tab, SHA-256 unchanged, tree clean |
| Automatic fallback works | **PASS** | Unreachable `badendpoint/dead-model` (127.0.0.1:9) → failover note naming both models → session model switched to `local-ollama/qwen-coder-local` → real answer `pong`; temp provider deleted afterwards |
| Second model actually available | **PASS** | `ollama serve` started; `qwen2.5-coder:1.5b` listed; `smoke-models.mjs` → `SMOKE_OK 2 models answered` |
| Build + regression tests | **PASS** | `BUILD_OK extension.js=26274500B webview=ok`; 1687 vitest pass (116 files); 1244 bun unit pass (92 files); `tsc --noEmit` exit 0; biome clean |
| Final workspace cleanliness | **PASS** | `git rev-parse --short HEAD` → `22d92470`; `git status --porcelain` → empty; `helpers.py` SHA-256 `ac96607b…` |
| Remaining recording blockers | **NONE functional** | Operational notes below; video not recorded (out of scope) |

### Explicitly UNVERIFIED / not claimed

- **No demo video exists.** Timestamps remain `TBD`.
- **Inline per-hunk checkboxes inside the diff tab** are not implemented and were not claimed;
  the real control is the per-hunk modal (`Accept Hunk` / `Reject Hunk`), which was exercised.
- GitHub push and portal submission remain out of scope; the write-up still has the
  `github.com/<owner>/<repo>` placeholder.

---

## Defects found in this rehearsal (fixed)

### 1. Inline edit trusted any active editor, including a diff/preview tab

**Repro (real host):** accept an inline edit, leave the resulting
`Forge inline edit: …` tab active, select text in it and press `cmd+alt+k`. The Forge input
box opened and the model reasoned about the **preview document**: it replied that
`get_debug_flag` “already treats off and n as false”, because it was reading the right-hand
side of the diff, not the workspace file. Applying that proposal would also have written to
the `cline-edit-preview:` URI.

**Fix:** `inlineEditDocumentRejection()` in `inline-edit-core.ts`, checked before the
instruction box. It refuses closed documents, untitled buffers, and any non-`file` scheme
with a specific message. Live re-check: untitled buffer → warning, no input box; Forge diff
tab → “this is a diff or preview tab, not a file”, no input box.

### 2. Content captured before the model call was applied without a drift check

The request content is captured before the turn and the accepted hunks are applied after the
review. Any edit made during that window would be overwritten by content computed from stale
bytes. **Fix:** `hasDocumentDrifted()` checked immediately before writing; on drift Forge
refuses with “the file changed while Forge was working, so nothing was written” and leaves
the file alone.

**Tests:** 7 new unit tests in `inline-edit-core.test.ts` (file accepted; diff scheme,
other non-file schemes, untitled, closed rejected; drift true/false). Commit `bda6404`.

---

## Evidence

- `report/evidence/recording-readiness/run-log.json` — every run, SHA-256 before/after,
  `git status`, failover and test results.
- `report/evidence/recording-readiness/` — real screenshots: 2-hunk modal at Hunk 1/2 and
  Hunk 2/2, applied diff, untitled-buffer guard, diff-tab guard, Escape-cancel.
- `report/evidence/recording-readiness/failover-live-evidence.json` and
  `failover-live-cleanup.json`.

Key hashes: original `ac96607bbfc9dbcf09d5442fe7e90d7f8a046b0df7d8f3fc3535b44112016d71`;
single-hunk accept `43896bbc…`; two-hunk accept-1 `9e989e58…`; post-fix accept `6e28f650…`;
every undo returned to `ac96607b…`.

Failover: 4.2 s, `finishReason: completed`, text `pong`, note
`[Forge] badendpoint/dead-model unavailable ([Model Error] Cannot connect to API: bad port); failing over to local-ollama/qwen-coder-local`,
`sessionModel.name = local-ollama/qwen-coder-local`, workspace unchanged, providers restored
to `["local-ollama","opencode-free-models"]`, agent spec byte-identical.

---

## Operational notes for the recording

1. **Start Ollama before the fallback beat:** `ollama serve &`; `qwen2.5-coder:1.5b` is already
   pulled. Without it the honest demo is the “all models unavailable” path, not a successful
   fallback.
2. **Click the file's own tab before `cmd+alt+z.`** The first attempt after a review did nothing
   because the diff tab had focus; with the file tab focused the keybinding restored exact bytes.
   This is focus behaviour, not a broken binding (the empty-stack toast proves it fires).
3. **Do not press `cmd+alt+k` while a Forge diff tab is active.** It is now refused with a
   warning; that is the fix working.
4. The free gateway can still emit a transient `Body Timeout Error`; retry/backoff handles it,
   but allow a few seconds on camera.
5. Launching the dev host for automation needs `--force-renderer-accessibility`; a human
   recording does not.

---

## Verification commands (all re-run after the fix)

```bash
node .unlazy/verify/fork-point.mjs      # FORK_POINT_OK
node .unlazy/verify/trueforge-up.mjs    # TRUEFORGE_UP
node .unlazy/verify/mcp-tools.mjs       # MCP_TOOLS_OK (8 tools)
node .unlazy/verify/hygiene.mjs         # HYGIENE_OK
node .unlazy/verify/writeup.mjs         # WRITEUP_OK (8 headings)
node .unlazy/verify/demo-script.mjs     # DEMO_SCRIPT_OK
node .unlazy/verify/smoke-models.mjs    # SMOKE_OK (2 models answered)
node .unlazy/verify/build.mjs           # BUILD_OK extension.js=26274500B
cd apps/vscode && npx vitest run --config vitest.config.ts   # 1687 passed
cd apps/vscode && bun scripts/run-bun-unit-tests.ts          # 1244 passed
```

**READY to record.**
