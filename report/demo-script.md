# Forge — Round 1 demo script (≤ 4:00, Tasks A → B → C, on-screen verification, TF session in Task B)

Pre-flight (not recorded): flask checkout at tag 3.1.3 is PRISTINE (`git status` empty) ·
TrueForge up on localhost:8790 (provider = working gateway) · fallback answering: `ollama serve`
with `qwen2.5-coder:1.5b` pulled (check: `node .unlazy/verify/smoke-models.mjs` → SMOKE_OK) ·
dev host window open on the flask folder · Cline panel visible · terminal font big ·
screen aspect 16:9 · **you hit record now**.

## Shot 1 — Task A (0:00–1:20)
1. Click Cline view → New Task. Editor: helpers.py visible (git diff badge clean).
2. Type: `Select the function get_debug_flag in helpers.py and treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.`
3. Cut nothing between instruction and diff. Stream shows AGENT text → tool calls (repo_map → retrieve → read_file → propose_edit).
4. Approve the two hunks (per-hunk Accept: the code change and the docstring). Nothing is written until both review answers are recorded; the tool then applies only the accepted hunks. Toast confirms the applied count.
5. Verification on screen: terminal — `FLASK_DEBUG=off .venv/bin/python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"` → prints **False**. Show docstring in the editor pane.

## Shot 2 — Task B (1:20–3:00)
1. New Task. Type the exact brief (NO file mentions):
   `Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.`
2. Agent shows discovery (repo_map → retrieve → search cli.py → read_file on cli.py, cli.rst, test_cli.py). No file names were given.
3. Approve each proposal: src/flask/cli.py (config command registered in FlaskGroup), tests/test_cli.py (new TestConfig class), docs/cli.rst ("Show the Config"), docs/api.rst (autodata config_command).
4. TrueForge session visible for this run briefly — ego lite window, already on screen showing the sessions list; click the new flask session; the detail shows TURN=1, model `opencode-free-models/deepseek-v41-flash-free`, TOOL CALLS count, timeline and "Agent steps" (editor_repo_map → editor_retrieve → …). (navigate with: ego-browser → goto `http://localhost:8790/sessions?view=sessions`, `Emulation.setDeviceMetricsOverride {width:1320, height:660, deviceScaleFactor:2}` — the window's webview is a fixed 660×660 so the desktop SPA needs the emulated viewport; leave the window on the session detail for the camera.)
5. Verification on screen — terminal:
   - `.venv/bin/python -m pytest tests/test_cli.py -q` → **58 passed, 3 skipped**
   - `.venv/bin/flask --help | grep -A2 config` → command listed
   - demo app with SECRET_KEY / DB_PASSWORD / API_TOKEN / NORMAL, run `flask config` → sensitive values `***`, NORMAL visible
   - `git diff --stat` → ≥3 files

## Shot 3 — Task C (3:00–4:00)
1. `git stash` (tree is clean now — this is what "no files changed" means here).
2. Break the endpoint (terminal, shown): `curl -X PUT .../settings/model-providers` base_url → `http://127.0.0.1:9/v1` (or TF Settings → Models).
3. Repeat the Task A instruction. The chat shows `[Forge] … unavailable (…); failing over to local-ollama/qwen-coder-local` and the turn continues on the real second model instead of erroring. Point at the TrueForge session detail: its model is now `local-ollama/qwen-coder-local`. (Verified 2026-11-19: 4.2 s, session model switched, real `pong` answer, workspace untouched.)
   Optional second beat if time allows: stop Ollama (`pkill ollama`) and repeat → one clear error naming **both** models, editor responsive, cancel still works (cancel during backoff returned in 45 ms).
4. `git status --short` → empty output (shown).
5. Restore provider; note for the write-up: configured fallback present; clear error is the demonstrated anchor.

## Safety beats worth showing
- Skip every hunk in the review → the tool refuses (`status: "unreviewed"`) and the file is byte-identical. This is the fail-closed gate; do not cut it.
- `Forge: Undo Last Edit` after an applied edit restores the exact pre-edit bytes and refuses if the file changed since. Click the file's own tab first: `cmd+alt+z` needs editor focus (with the diff tab focused it does nothing, by design).
- Pressing `cmd+alt+k` while a Forge diff tab is active is now refused with a warning; that is the guard, not a failure.

## Editing notes
Cut model-wait gaps only; never cut instruction → diff appearing; keep order A → B → C; keep the TF session visible for ≥5s in Task B; total ≤ 4:00.

## Observed in the full dry run (2026-11-18, one sitting)
- Task A: ~6 approvals expected (ls/retrieve early, propose_edit, pytest run, matrix verification command). The agent seeds `ls` + `git log` first; it checks its own work and reports the 2 pre-existing failures itself (async extra, test_bad_environ_raises_bad_request) — show this if pace allows; it is a strong signal.
- Task B: ~8-10 approvals; the agent first reads widely (cli.py in chunks, cli.rst, api.rst, test_cli.py, CHANGES.rst); it proposes cli.py → tests → then **self-corrected a missing `import json`** in a follow-up edit without being asked; two docs proposals come as one message (two Approve buttons — click both); it runs the full suite and proves the 2 failures pre-existing via git stash itself.
- Task C: relaunch needed between B and C if the window died; Provider base_url → 127.0.0.1:9; the error renders in ~2s.
- The dev host window has been EVICTED repeatedly (this automation environment) — if it happens live on camera, relaunch with: /usr/bin/open -na "/Applications/Visual Studio Code.app" --args --extensionDevelopmentPath=…/apps/vscode --user-data-dir=…/vscode-userdata …/forge-demo/flask and continue; exactly the kind of resilience the video should not hide (mention it in the write-up if it happens).
- Verification commands for the video terminal beats:
  - ``FLASK_DEBUG=off .venv/bin/python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"`` → False
  - ``.venv/bin/python -m pytest tests/test_cli.py -q`` → 58 passed, 3 skipped (baseline on a clean 3.1.3 checkout is 55 passed, 3 skipped); full suite: 2 failures remain, both pre-existing on tag 3.1.3 (async extra, Werkzeug version) and confirmed by the agent via `git stash`
  - ``.venv/bin/flask --help`` → `config` listed under Commands
  - ``.venv/bin/flask --app /private/.../maskdemo.py config`` → SECRET_KEY/PASSWORD/TOKEN/KEY as ***
