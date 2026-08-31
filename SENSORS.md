# Backpressure user-defined sensors

## Goal

Sensors let a repository define its own linters-as-gates. A sensor is a
declarative description of an external tool (ESLint, a custom scanner, a
regex checker) that backpressure runs against every candidate write/edit
content before it lands. A finding in block mode stops the write with a
4-line verdict; a finding in advise mode is collected and delivered to the
agent as a session advisory. A former built-in complexity rule has been
migrated to an example sensor in `sensors-examples/complexity/`.

## Installing a sensor

Sensor definitions live in `.backpressure/sensors/` (create it if missing).
Discovery happens on every gated write/edit, so edits apply without
restarting the session. Supported file names: `*.yaml`, `*.yml`, `*.json`
(JSON is parsed with `JSON.parse`). Auxiliary data files (e.g. a scanner's
rule config) may live in the same directory: any YAML file without a
top-level `id:` key is ignored, while a malformed sensor definition makes
only that sensor inert and emits a `probe.sensor.config {file, error}`
event; other sensors are unaffected.

Set `BACKPRESSURE_SENSORS_DIR` to load sensors from a different directory
(used by the validation matrix and by multi-repo setups). User rules in
`.backpressure/rules/` are never touched by sensors.

```powershell
New-Item -ItemType Directory -Force ".backpressure\sensors" | Out-Null
Copy-Item "sensors-examples\complexity\*" ".backpressure\sensors\"
```

## Schema

```yaml
id: eslint                        # REQUIRED, unique, ^[a-z0-9-]+$
description: "ESLint as a backpressure sensor"
command: ["npx", "--no-install", "eslint", "--format", "json", "{file}"]  # argv ARRAY, no shell
timeoutMs: 20000                  # default 20000
cwd: "{workdir}"                  # default {workdir}; {sensorDir}/{root} allowed
env: { NODE_ENV: production }     # additive over process.env
triggers:
  include: ["src/**/*.ts", "engine/**/*.ts"]   # rel-to-workdir globs, 3 shapes
  exclude: ["**/*.test.ts"]                     # exclude wins
  tools: [write]                  # default [write]; edit is opt-in
format:
  type: json                      # json | regex | preset:eslint-json
  findingsPath: ""                # json only: dot-path to a FLAT array (default "" = root array)
  fields:                         # json only: per-finding dot-paths, graceful degradation
    ruleId: ruleId
    path: path
    line: line
    message: message
    severity: severity
  pattern: "..."                  # regex only: JS named-group pattern, line-by-line
exitCodes:
  findings: [0]                   # exit codes whose stdout is parsed as findings
severity:
  map: { "2": ERROR, "1": WARNING, info: INFO }  # keys are stringified raw values
  default: INFO                   # unmapped/missing severity resolves to INFO
defaults:
  why: ""
  instead: ""
  appealable: true
lifecycle:
  status: adopted                 # draft | adopted
  mode: block                     # block | advise
ratchet: {}                       # RESERVED for future use (parsed but ignored)
```

### Trigger globs (3 shapes, matched against workdir-relative paths)

- `dir/**` - any path under `dir/`
- `**/*.ext` - any path ending in `.ext`
- `exact/path` - exact relative path

Exclude patterns win over include. A write is checked with `content`, an
edit with `newText`; a sensor whose `tools` does not list the current tool
reports `no-candidate` and never spawns.

### Placeholders (literal replacement in argv, cwd; no shell, no env expansion)

| Placeholder    | Resolves to                                     |
| -------------- | ----------------------------------------------- |
| `{file}`       | absolute path of the scratch copy               |
| `{relPath}`    | workdir-relative path (`src/a.ts`)              |
| `{fileName}`   | file name only (`a.ts`)                         |
| `{root}`       | per-sensor scratch root (multi-file rescan)     |
| `{sensorDir}`  | real directory containing the sensor definition |
| `{workdir}`    | the session workdir                             |

## Output formats

- `json` - stdout must be JSON; `findingsPath` locates a flat array of
  findings, `fields` maps each finding's dot-paths. Missing fields degrade
  to undefined and fall back gracefully at render time.
- `preset:eslint-json` - hardcoded ESLint mapping: top-level array of
  `{filePath, messages:[{ruleId, line, message, severity}]}`, severity
  `2` -> ERROR, `1` -> WARNING, exit codes `[0, 1]`.
- `regex` - JS named-group pattern applied line-by-line to stdout. Groups:
  `file` (mapped through the scratch rel-to-real map), `line`, `message`,
  `ruleId`, optional `severityGroup` (mapped via `severity.map`). Missing
  groups degrade.

## Exit codes and fail-open contract

- spawn error or kill on timeout -> fail-open, reason `timeout`
- code in `exitCodes.findings` -> stdout parsed for findings
- code not in `exitCodes.findings` -> fail-open, reason `exit:<code>`
  (findings are empty even if stdout would parse)
- unparseable output -> fail-open, reason `unparseable`
- binary not found -> no spawn, reason `no-bin` (bare names are searched on
  `PATH`/`PATHEXT`; path-like first args must exist)

A sensor path NEVER throws and NEVER blocks on config errors, tool
failures, timeouts, or unparseable output: every failure mode is
fail-open per sensor. Non-matching sensors stay completely silent.

## Severity and lifecycle

Severity tiers are `ERROR`, `WARNING`, `INFO`; `INFO` findings are ignored.
The lifecycle resolves exactly like rules: `draft` + `block` fails closed to block
with `modeConflict`, `draft` (default) advises, `adopted` + `advise` fails
closed to block with `modeConflict`, `adopted` (default) blocks. Lifecycle
is resolved once per sensor and stamped on its findings, so the full
matrix (including `modeConflict`) applies unchanged.

## Precedence

Engine precedence is `tool-path`, `shell-write`, `semgrep`, `sensor` -
first match wins. Sensor findings masked by an earlier rule are still
logged via `probe.sensor.run`.

## Events

- `probe.sensor.run {sessionID, callID, sensorId, ran, reason?, findings, durationMs}`
  - emitted even when `ran: false`
- `probe.sensor.config {file, error}` - broken sensor definition
- blocked verdicts add `sensorId`, `toolRule` (when different from the
  check id) and `line` (when numeric)
- `probe.advise.rescan` carries `sensorFindings`/`sensorReason` instead of
  the retired complexity fields

## Latency guidance

Sensors run sequentially on the write path; keep `timeoutMs` tight (1-3s
for stubs and formatters, 20s for full linters) and prefer trigger globs
that skip generated files and tests. The scratch copy is removed in a
`finally` block, so no residue is left behind.

## Ratchet (reserved)

A `ratchet:` section is parsed but ignored in this release; a ratchet store
(baseline snapshots with tolerances) is possible future work.
