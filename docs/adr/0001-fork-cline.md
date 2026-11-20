# ADR-0001: Fork Cline as the editor shell

**Status:** accepted · 2026-11-17

## Context

Forge-a-thon requires a VS Code extension whose agent loop runs on TrueForge.
We need diff rendering, streaming webview, approvals and checkpoints without
rebuilding them.

## Decision

Fork `cline/cline` at commit `eff43e19b267e171f597ab03733bfed25090f72d`
(2026-11-17, `main`). Upstream LICENSE (Apache-2.0) is preserved unchanged in
`LICENSE`. Our delta lives in `apps/vscode/src/trueforge/` and `.trueforge/`.
The agent loop itself is executed by TrueForge, never by the upstream Cline
SDK loop.

## Alternatives considered

- Continue, Roo Code: weaker diff/checkpoint UX; Roo upstream dormant.
- opencode: TUI/SDK, no editor-native per-hunk review.
- From scratch: cannot ship Round 1 in ~72h.

## Consequences

- Judges see our delta from the pinned fork commit; upstream attribution intact.
- The upstream SDK loop is replaced at the session-host boundary; no direct
  provider calls survive in our engine path (CI grep audits this).
