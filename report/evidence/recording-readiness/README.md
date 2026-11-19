# Recording-readiness evidence

Collected 2026-11-19 from a real VS Code **Extension Development Host** (v1.147.0) driving
the Forge extension against the real TrueForge server on `localhost:8790`, with the demo
workspace at `/Users/mohaksinghal/Documents/GitHub/forge-demo/flask` pinned to Flask 3.1.3
(`22d92470`).

## Files

| File | What it shows |
| --- | --- |
| `run-log.json` | Every UI run with the exact SHA-256 before/after and `git status`; failover, model, test and gate results. |
| `step13-twohunk.png` | Real diff tab titled `Forge inline edit: src/flask/helpers.py (2 hunks)` and the per-hunk modal on **Hunk 1/2**. |
| `step15-hunk2b.png` | The same run advanced to **Hunk 2/2** (docstring reword) after accepting hunk 1. |
| `step20-after-accept.png` | Applied result in the diff view: only the accepted hunk is on the right side. |
| `step21-diff-guard.png` | New guard: `cmd+alt+k` with the diff tab active shows "this is a diff or preview tab, not a file" and opens no input box. |
| `step18-untitled-guard3.png` | New guard: untitled buffer shows "this is an untitled buffer with no file on disk" and opens no input box. |
| `step22-escape-cancel.png` | Escape in the instruction box: no write, no new tab, file unchanged. |
| `failover-live-evidence.json` | Unreachable primary -> failover note -> session model switched -> real `pong` from `local-ollama/qwen-coder-local`. |
| `failover-live-cleanup.json` | Temporary provider deleted, original providers and agent spec restored. |
| `smoke-models.txt` | Both configured models answered a real smoke turn (`SMOKE_OK`). |

## Reproduce

```bash
# TrueForge
curl -s localhost:8790/api/v1/settings/model-providers | head -c 300

# Models (needs a running daemon for the fallback)
ollama serve &
node .unlazy/verify/smoke-models.mjs            # SMOKE_OK

# Failover
bun /tmp/tf-failover-live.mjs                   # see failover-live-*.json

# UI runs: see run-log.json; the workspace must be pristine before each run
cd /Users/mohaksinghal/Documents/GitHub/forge-demo/flask
git rev-parse --short HEAD                      # 22d92470
git status --porcelain                          # empty
shasum -a 256 src/flask/helpers.py              # ac96607b...
```

## Notes

- The dev host must be launched with `--force-renderer-accessibility` for the per-hunk
  modal buttons to be inspectable by automation. A human recording the video does not need it.
- `cmd+alt+z` only fires when a text editor has focus. After the review modal closes, click
  the file's own tab before pressing it.
- The Forge diff tab is now refused by inline edit, so the demo cannot accidentally edit the
  preview document.
