# Forge Round 1 walkthrough

**Target length: 3:45–3:55.** Record the editor, TrueForge, and verification terminal. Keep the task order A → B → C. Do not cut from an instruction to the first proposal. Model wait time may be shortened if the edit itself remains continuous.

## Before recording

- Use a fresh Flask 3.1.3 checkout at tag `3.1.3`; confirm `git status --short` is empty.
- Start TrueForge and the VS Code Extension Development Host with the Forge workspace open.
- Confirm the cloud primary and Groq fallback answer using `node .unlazy/verify/smoke-models.mjs` (`SMOKE_OK`).
- Prepare this synthetic Flask app outside the checkout as `/tmp/forge-mask-demo.py`. Use dummy values only:

  ```python
  from flask import Flask
  app = Flask(__name__)
  app.config.update(SECRET_KEY="demo-secret", DB_PASSWORD="demo-password", API_TOKEN="demo-token", NORMAL="visible")
  ```
- Keep API keys and provider settings out of frame. Use a readable terminal font and a 16:9 capture.
- Prepare the Flask virtual environment and verification commands before recording. Keep the environment outside the clean checkout or ignored.

## Shot 1 — Task A · Inline edit · 0:00–1:05

1. Open `src/flask/helpers.py`, select the full `get_debug_flag` function, and invoke Forge inline edit with `Cmd+Option+K`.
2. Enter the task instruction: “Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.”
3. Keep the instruction-to-diff sequence continuous. Show the proposal, review controls, and the hunk decision. Accept the intended change.
4. In the terminal, run `FLASK_DEBUG=off .venv/bin/python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"` and repeat with `FLASK_DEBUG=n`. Show `False` for both, then show the updated docstring. If time permits, repeat with `OFF` and `N` to demonstrate case-insensitivity.

## Shot 2 — Task B · Agent mode and context · 1:05–2:40

1. Start a new task without selecting code or naming files. Enter this exact request:

   > Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.

2. Show the context budget and selected-file reasons, then the agent's discovery and multi-file proposal. Keep the instruction-to-proposal sequence continuous.
3. Review and accept the intended edits. Briefly show the matching TrueForge session and its MCP tool activity.
4. Verify in the terminal: `.venv/bin/python -m pytest tests/test_cli.py -q`, `.venv/bin/flask --help`, and `.venv/bin/flask --app /tmp/forge-mask-demo.py config`. Show the test result, `config` in help, sensitive values replaced with `***`, and `NORMAL` still visible.

## Shot 3 — Task C · Cloud failover and safe rejection · 2:40–3:50

1. Switch to a separate pristine Flask 3.1.3 checkout for C. Show `git status --short` is empty.
2. In TrueForge model settings, temporarily set the primary base URL to `http://127.0.0.1:9/v1` while keeping the TrueForge server and Groq fallback available. Do not expose provider credentials. Repeat the exact A instruction in Forge.
3. Show the primary failure, automatic switch to Groq `gpt-oss-120b`, and the returned proposal. Reject its hunk; show Forge's rejection result and the TrueForge session's active fallback model.
4. Run `git status --short` and show the workspace is still clean. Restore the primary provider setting after recording.

## Closing check · 3:50–3:55

End on the three visible verification outcomes. Keep the final video under four minutes and publish a link that judges can open without requesting access.

## Recording cautions

- The demo video has not yet been recorded. Add real final-cut timestamps to the write-up only after publishing it.
- Press `Cmd+Option+Z` with the source file tab focused when showing undo. The diff preview cannot start a new inline edit; its guard is expected behavior.
- Do not show a clean-workspace check by resetting or cleaning the C checkout after the task. Prepare C as a separate pristine workspace before recording.
