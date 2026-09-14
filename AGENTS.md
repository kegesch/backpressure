# backpressure

Harness-agnostic enforcement engine for AI coding agents, delivered as opencode
project plugins. See [README.md](README.md) for the full overview.

## Official extension documentation — KEEP IN SYNC

> **`.opencode/skills/backpressure-extend/SKILL.md` is the OFFICIAL
> documentation for extending backpressure.** It is the authoritative guide for
> when to use each mechanism — **semgrep rule**, **sensor**, or **commit
> validator** — and how to write each.

Whenever you add, change, or remove a guardrail mechanism or an extension point
(a rule, sensor, validator, tier, lifecycle option, env var, or state knob),
you MUST update `.opencode/skills/backpressure-extend/SKILL.md` to reflect it.
Do not add a new extension point without documenting it there. Keep the skill
accurate, current, and aligned with the actual behavior in `engine/` and the
`.opencode/plugins/`.

The skill is installed alongside the plugin (it ships inside `.opencode/` and is
injected to agents via `skills.paths` in `opencode.json`; the plugin auto-ensures
that path, resolved from its own `import.meta.url`, so it stays plugin-relative),
so it is what future agents — and consumers of this repo — rely on to extend
backpressure. An
out-of-date skill is worse than none. Keep `opencode.json` (`plugin` + `skills`)
in sync with the actual plugin/skill files.

## Project conventions

- **Engine** (`engine/`): pure, harness-agnostic TypeScript importing only
  `node:*` builtins (so `bun test` stays hermetic). New extension-point logic
  lives here with a matching `*.test.ts`.
- **Plugins** (`.opencode/plugins/`): opencode wiring. `index.ts` composes all
  probes into one plugin. Fail open on missing dependencies; block by throwing.
- **Verify**: `bun test engine/` (all tests must pass).
- When adding to the skill's decision guide or examples, mirror the real
  schemas in `SENSORS.md`, `rules-staged/`, `validators-staged/`, and
  `engine/tier0-checkers.ts`.