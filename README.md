# backpressure

Harness-agnostic enforcement engine for AI coding agents, delivered as
[opencode](https://opencode.ai) project plugins. Backpressure keeps agents
inside **user-defined guardrails** — protected paths, forbidden shell writes,
static-analysis rules, and your own linters-as-sensors — by intercepting
tool calls and rejecting violations with **verdict-shaped BLOCK messages**
(WHY / INSTEAD / APPEAL). Nicer suggestions travel through a soft **advise
mode** that delivers findings when the session goes idle. Rules and sensors
are plain declarative YAML owned by the repository.

## Features

- **Hard gates** — writes/edits into protected paths (via `tool-path`) and
  shell commands with write intent against them (via `shell-write`) are
  blocked before they execute.
- **Semgrep-backed rules** — your own rules in `.backpressure/rules/*.yaml`
  scanned on every write/edit under the quality roots.
- **Rule lifecycle** — `status: draft` advises, `status: adopted` blocks;
  a `mode:` contradiction fails closed to block.
- **Advise at idle** — findings are collected and delivered once as a
  session advisory, re-delivered as a delta when new findings appear, with
  an opt-in idle re-scan.
- **User-defined sensors** — run any external tool/linter as data
  (`json` / `regex` / `preset:eslint-json` formats, exit-code and severity
  mapping). See [SENSORS.md](SENSORS.md).
- **Commit validators** — validate staged commits before they land. Rules
  run in tiers: tier 0 is deterministic JS (free, reliable), tiers 1/2 are
  LLM-judged in batches and return ACK/NACK, with an optional appeal path.
- **Zero mandatory external dependencies** — without semgrep/python the
  engine still enforces the path and shell gates; every optional tool fails
  open when absent.

## Getting started

Prerequisites: [opencode](https://opencode.ai). Optionally
[bun](https://bun.sh) to run the test suite.

1. Copy the plugins and engine into your repository:

   ```powershell
   Copy-Item -Recurse <this-repo>\.opencode\plugins <your-repo>\.opencode\
   Copy-Item -Recurse <this-repo>\.opencode\skills <your-repo>\.opencode\
   Copy-Item -Recurse <this-repo>\engine <your-repo>\
   ```

   The `skills` copy is optional but recommended: `.opencode/skills/
   backpressure-extend/` installs a `backpressure-extend` agent skill alongside
   the plugin that explains when to add a rule, sensor, or validator and how to
   write each.

   The plugins import `@opencode-ai/plugin` **for types only**, so nothing
   needs to be installed for them to load. A minimal `package.json` with
   `@opencode-ai/plugin` in `devDependencies` is included for editor
   type-checking and the `test` script — `bun install` is optional.

   Enable backpressure with a **single plugin entry** in `opencode.json`
   (recommended — it composes all probes):

   ```jsonc
   // opencode.json
   {
     "plugin": [".opencode/plugins/index.ts"]
   }
   ```

   `.opencode/plugins/index.ts` runs every probe (gates, commit validators,
   advise delivery, idle audit, permission audit) in one plugin, chaining
   shared hooks in order. Alternatively list the individual probes under
   `plugin` (see `.opencode/plugins/`).

2. Create your state directories (user-owned; the engine only appends to
   its hook log there):

   ```powershell
   New-Item -ItemType Directory -Force ".backpressure\rules", ".backpressure\sensors" | Out-Null
   ```

3. Copy example rules from `rules-staged/` into `.backpressure\rules\`
   and/or the example sensor from `sensors-examples\complexity\` into
   `.backpressure\sensors\` (that sensor optionally needs
   `python -m pip install --user tree-sitter tree-sitter-typescript pyyaml`).

4. Restart opencode, then try a violating action — e.g. write into
   `.backpressure\` or add an `eval(...)` call with `no-eval.yaml`
   adopted — and watch the write come back with a BLOCK verdict.

## How it works

Each write/edit/shell tool call is evaluated in a fixed order,
**first match wins**:

1. `tool-path` — is a protected path (`.backpressure/**`) a read/write
   target of the call?
2. `shell-write` — does the shell command carry write intent against a
   protected path?
3. `semgrep` — do user rules match the candidate file content?
4. `sensor` — do user-defined sensors report findings?

A block verdict is a short, structured message:

```
BLOCKED by <rule id>
WHY: <why the change was rejected>
INSTEAD: <what to do instead>
This verdict is appealable: reply with your reasoning to override.
```

Findings with `status: draft` (or `mode: advise`) are not blocked; they are
collected and delivered **when the session goes idle** as one advisory.
If a later delivery contains findings the agent has not seen yet, only the
delta is re-delivered. An opt-in idle re-scan re-runs analyzers between
turns.

Every gate decision and advisory collection is appended to
`.backpressure\hook-log.jsonl` (`probe.*` events), so enforcement is fully
auditable after the fact.

## Sensors

Sensors turn any external tool — ESLint, a regex checker, a custom
scanner — into a declarative gate or advisory source: describe the command,
trigger globs, output format, exit codes, and severity mapping in YAML, and
backpressure runs it against candidate writes with a strict per-sensor
fail-open contract. Full schema, placeholders, and examples:
[SENSORS.md](SENSORS.md). A migrated real-world example lives in
[`sensors-examples/complexity/`](sensors-examples/complexity/).

## Commit validators

The `commit-probe` plugin intercepts every `bash` tool call that looks like a
`git commit` and validates the staged change against your markdown rule files
before it is allowed to run.

**Auto-init on load** — the plugin needs no commands. When opencode loads it,
it creates `.backpressure/` plus `.backpressure/validators/` and writes a
default `.backpressure/commit-validators.json` state file if absent. There are
no slash commands.

**Activation** — copy rule files from `validators-staged/` into
`.backpressure/validators/` and restart opencode. Each validator is a markdown
file whose frontmatter drives behavior:

```yaml
---
name: dead-code
description: Detects unused code that should be removed
enabled: true
tier: 2
---
```

- `name` — stable id used in results, overrides, and appeals.
- `description` — human summary (logged on load).
- `enabled` — `false` disables; default true.
- `tier` — `0` = deterministic JS checker (no LLM, no tokens), `1` = small
  model, `2` = capable model. Absent/invalid tiers default to `2`. Tier-0
  names must match one of the built-in checkers (e.g. `no-dangerous-git`,
  `hygiene`, `coverage-rules`, `type-organization`,
  `testing-weak-assertions`, `infra-commit-format`,
  `commit-message-no-speculation`, `ketchup-plan-format`).

The `appeal-system` validator (tier 2) is filtered out of the main run and
used only to judge `[appeal: …]` requests.

**State knobs** (`.backpressure/commit-validators.json`):

- `validateCommit.mode` — `strict` (block on NACK), `warn` (log the violation,
  let the commit through), or `off` (skip validation).
- `validateCommit.batchCount` — validators per batched LLM call (default 3).
- `models.tier1` / `models.tier2` — optional `{ providerID, modelID }` refs
  used when prompting the batched tier-1/2 runs.

**Appeal** — add `[appeal: your justification]` to the commit message. If every
NACK is appealable, the `appeal-system` validator judges it; an ACK lets the
commit through, a NACK appends the denial to the block message.

**Environment variables:**

- `BACKPRESSURE_VALIDATORS_DIR` — override where validator markdown is loaded
  from (default `.backpressure/validators/`).
- `BACKPRESSURE_COMMIT_LLM_TIMEOUT_MS` — per-validator LLM timeout (default
  90000).

**Fail-open contract** — if no LLM executor is available, tier-1/2 validators
are skipped (only tier-0 runs); if every tier-1/2 batch crashes, the commit is
allowed; any unexpected error logs `probe.commit.error` and lets the commit
through. Only a deliberate NACK (or an appeal denial) blocks the tool call.

## Development

```powershell
bun install   # optional: editor type-checking only
bun test engine/   # 282 unit tests
```

## Repository layout

- `.opencode/plugins/` — the opencode project plugins (`index.ts` composes
  all of them for a single `opencode.json` entry; gates, advise delivery,
  idle re-scan, commit validation)
- `.opencode/skills/backpressure-extend/` — agent skill for deciding and
  writing rules, sensors, and validators (installs with the plugin)
- `engine/` — harness-agnostic evaluation core (rules, semgrep, sensors,
  advisories, commit validators, tier-0 checkers) with its test suite
- `rules-staged/` — example semgrep rules to copy into `.backpressure/rules/`
- `validators-staged/` — example commit validators to copy into
  `.backpressure/validators/`
- `sensors-examples/complexity/` — example sensor (tree-sitter complexity
  scan)
- [`SENSORS.md`](SENSORS.md) — sensor schema, formats, fail-open contract
