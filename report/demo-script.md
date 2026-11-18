# Forge — Round 1 demo script (≤ 4:00, Tasks A → B → C, on-screen verification, TF session in Task B)

Pre-flight (not recorded): flask checkout at tag 3.1.3 is PRISTINE (`git status` empty) ·
TrueForge up on localhost:8790 (provider = working gateway) · dev host window open on the flask folder ·
Cline panel visible · terminal font big · screen aspect 16:9 · **you hit record now**.

## Shot 1 — Task A (0:00–1:20)
1. Click Cline view → New Task. Editor: helpers.py visible (git diff badge clean).
2. Type: `Select the function get_debug_flag in helpers.py and treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.`
3. Cut nothing between instruction and diff. Stream shows AGENT text → tool calls (repo_map → retrieve → read_file → propose_edit).
4. Approve the hunk (per-hunk Accept). Toast/diff applies in place.
5. Verification on screen: terminal — `FLASK_DEBUG=off .venv/bin/python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"` → prints **False**. Show docstring in the editor pane.

## Shot 2 — Task B (1:20–3:00)
1. New Task. Type the exact brief (NO file mentions):
   `Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.`
2. Agent shows discovery (repo_map → retrieve → search cli.py → read_file on cli.py, cli.rst, test_cli.py). No file names were given.
3. Approve each proposal: src/flask/cli.py (config command registered in FlaskGroup), tests/test_cli.py (new TestConfig class), docs/cli.rst ("Show the Config"), docs/api.rst (autodata config_command).
4. TrueForge session visible for this run briefly — ego lite window, already on screen showing the sessions list; click the new flask session; the detail shows TURN=1, model `opencode-free-models/deepseek-v41-flash-free`, TOOL CALLS count, timeline and "Agent steps" (editor_repo_map → editor_retrieve → …). (navigate with: ego-browser → goto `http://localhost:8790/sessions?view=sessions`, `Emulation.setDeviceMetricsOverride {width:1320, height:660, deviceScaleFactor:2}` — the window's webview is a fixed 660×660 so the desktop SPA needs the emulated viewport; leave the window on the session detail for the camera.)
5. Verification on screen — terminal:
   - `.venv/bin/python -m pytest tests/test_cli.py -q` → **58 passed**
   - `.venv/bin/flask --help | grep -A2 config` → command listed
   - demo app with SECRET_KEY / DB_PASSWORD / API_TOKEN / NORMAL, run `flask config` → sensitive values `***`, NORMAL visible
   - `git diff --stat` → ≥3 files

## Shot 3 — Task C (3:00–4:00)
1. `git stash` (tree is clean now — this is what "no files changed" means here).
2. Break the endpoint (terminal, shown): `curl -X PUT .../settings/model-providers` base_url → `http://127.0.0.1:9/v1` (or TF Settings → Models).
3. Repeat the Task A instruction. The chat shows: `[Model Error] Cannot connect to API: bad port` with **Retry** / **Start New Task** — editor responsive, no crash.
4. `git status --short` → empty output (shown).
5. Restore provider; note for the write-up: configured fallback present; clear error is the demonstrated anchor.

## Editing notes
Cut model-wait gaps only; never cut instruction → diff appearing; keep order A → B → C; keep the TF session visible for ≥5s in Task B; total ≤ 4:00.
