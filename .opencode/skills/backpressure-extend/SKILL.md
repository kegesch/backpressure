---
name: backpressure-extend
description: Decide which backpressure mechanism to add (semgrep rule vs sensor vs commit validator) and how to write each. Use when the user wants to add or change a guardrail, or asks when to use a rule, sensor, or validator.
license: MIT
compatibility: opencode
metadata:
  audience: maintainers-and-agents
---

# Extending backpressure

Backpressure has **three** guardrail mechanisms. Before writing anything, pick
the right one — a guardrail in the wrong mechanism is slow, noisy, or fires at
the wrong time.

| Mechanism | Lives in | Runs when | Best for |
|---|---|---|---|
| **Semgrep rule** | `.backpressure/rules/*.yaml` | every write/edit | concrete code **patterns** in a single file |
| **Sensor** | `.backpressure/sensors/*.yaml` | every write/edit | wrapping an **existing external tool** (linter/scanner) |
| **Commit validator** | `.backpressure/validators/*.md` | `git commit` | whole **staged diff + message** checks, or LLM judgment |

Rule and sensor are **write-time**; validator is **commit-time**. They are not
interchangeable — choose based on *what you inspect* and *when you can afford to
run it*.

## Which one should I use?

Ask these questions in order:

1. **Does it check a `git commit` (diff + message + files) rather than one
   file?** → **validator**. Only validators see the whole staged change and the
   commit message. A rule/sensor can only inspect one candidate file at write
   time.

2. **Is there already an external tool that does this?** (ESLint, a custom
   scanner, a regex checker, a formatter) → **sensor**. Wrap it — don't re-code
   its logic as a pattern. Sensors handle arbitrary command invocations, output
   formats (`json` / `regex` / `preset:eslint-json`), exit codes, and severity
   mapping.

3. **Is it a syntactic code pattern you can express in semgrep syntax?**
   (e.g. `eval(...)`, `console.log(...)`, `@ts-ignore`) → **rule**. Zero external
   deps, deterministic, runs only on TS/JS under the quality roots.

4. **Does it need judgment, cross-file reasoning, or natural-language rules?**
   (dead code, "no speculative commit messages", "tests must accompany new
   code") → **validator**. LLM-judged (tier 1/2) or deterministic (tier 0).

Quick heuristics:

- **Noisy/expensive per-write check** → prefer a **validator** (runs once per
  commit, not every keystroke-write).
- **Deterministic, cheap, high-confidence pattern** → **rule** or **tier-0
  validator** (never pay LLM tokens).
- **Depends on a binary that may be absent** → **sensor** (it fails open cleanly
  when the tool is missing).
- **Commit-message quality / workflow rules** → **validator** (tier 0 can check
  the message without a model).

## When each mechanism blocks

All three share the same lifecycle semantics:

- `status: adopted` (or no status) → **blocks** the action with a verdict.
- `status: draft` / `mode: advise` → does **not** block; collects findings and
  delivers them as a session advisory when idle.
- A conflicting `status` + `mode` combination **fails closed to block**
  (`modeConflict`).
- Every mechanism is **fail open** on missing dependencies / tool errors — only
  a deliberate finding blocks.

---

## Adding a semgrep rule

File: `.backpressure/rules/<id>.yaml`

```yaml
rules:
  - id: no-eval
    languages: [typescript, javascript]
    severity: ERROR
    message: eval() is forbidden — dynamic code execution is unauditable
    pattern: 'eval(...)'
    metadata:
      backpressure:
        why: Why this is a violation.
        instead: What to do instead.
        status: draft        # omit or "adopted"; draft advises
        # mode: advise       # alternative to status:draft
        appealable: false    # optional; default true
```

- Scoped with `paths: { include: ["engine/**"], exclude: ["**/*.test.ts"] }`.
- `severity: ERROR | WARNING` blocks; `INFO` is ignored.
- Requires the `semgrep` binary to run; without it the rule **fails open** (no
  block). Keep rules under the quality roots (default `engine/`, set by
  `BACKPRESSURE_QUALITY_ROOTS`).

**Use a rule when** the violation is a specific, local code pattern you can
write in semgrep syntax and you want it checked on every write/edit with no
external tool.

---

## Adding a sensor

File: `.backpressure/sensors/<id>.yaml` — full schema in `SENSORS.md`.

```yaml
id: eslint
description: "ESLint as a backpressure sensor"
command: ["npx", "--no-install", "eslint", "--format", "json", "{file}"]
triggers:
  include: ["src/**/*.ts", "engine/**/*.ts"]
  exclude: ["**/*.test.ts"]
format:
  type: preset:eslint-json     # json | regex | preset:eslint-json
exitCodes:
  findings: [0]
lifecycle:
  status: adopted              # draft | adopted
  mode: block                  # block | advise
```

- The sensor wraps an external command; it **never throws** and fails open on
  missing binary / timeout / unparseable output.
- Placeholders like `{file}`, `{relPath}`, `{workdir}` resolve at run time.
- Trigger globs decide which files the sensor scans; exclude wins.

**Use a sensor when** you already have (or want to invoke) an external tool and
want its findings as a gate or advisory. This is the right home for
"run my linter against every write."

---

## Adding a commit validator

File: `.backpressure/validators/<name>.md`

```markdown
---
name: dead-code
description: Detects unused code that should be removed
enabled: true
tier: 2          # 0 = deterministic (no model), 1 = small model, 2 = capable model
---

You are a commit validator. You MUST respond with ONLY a JSON object.

Valid responses:
{"decision":"ACK"}
{"decision":"NACK","reason":"one sentence explanation"}

NACK if: <your rule conditions>
ACK if: <your pass conditions>
```

Then **activate** (validators don't auto-run from the repo):

```bash
cp validators-staged/*.md .backpressure/validators/
```

- **Tier 0** (deterministic, free) names must match a built-in checker in
  `engine/tier0-checkers.ts` (e.g. `no-dangerous-git`, `hygiene`,
  `commit-message-no-speculation`, `coverage-rules`). For a **new** tier-0
  rule, add a pure checker function to `engine/tier0-checkers.ts` **and** a
  matching `.md` with `tier: 0` so it surfaces in config.
- **Tier 1/2** are LLM-judged from the staged diff + message + files. If no LLM
  executor is available they are skipped (fail open).
- To add an appeal flow, include an `appeal-system` validator; agents can then
  override NACKs with `[appeal: reason]` in the commit message.
- Commit validation mode: `validateCommit.mode` in
  `.backpressure/commit-validators.json` — `strict` (block) / `warn` (log only)
  / `off`.

**Use a validator when** the check must see the whole commit (diff + message),
needs judgment, or would be too slow/noisy to run per-write.

---

## Example scenario mapping

| You want to... | Use |
|---|---|
| Block `eval()` in TS files | **rule** |
| Block `console.log` in `engine/` | **rule** (scoped) |
| Enforce your ESLint config on every write | **sensor** |
| Run a custom regex scanner on `.md` files | **sensor** |
| Reject commit messages with "should work"/"maybe" | **validator** (tier 0) |
| Reject dead code / unused imports in a commit | **validator** (tier 2) |
| Require tests accompany new code | **validator** (tier 2) |
| Block dangerous git flags (`--no-verify`, `--force`) | **validator** (tier 0, built-in) |

## Workflow

1. Pick the mechanism using the guide above.
2. Write the file in the correct directory (or add a checker + validator for a
   new tier-0 rule).
3. For a **rule/sensor**: it's picked up on the next write — no restart needed.
   For a **validator**: copy it into `.backpressure/validators/` and restart
   opencode.
4. Make a violating action and confirm the block (or advisory). Check
   `.backpressure/hook-log.jsonl` for `probe.*` events to debug.