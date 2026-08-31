# Example sensor: cyclomatic complexity (tree-sitter)

A user-defined backpressure sensor that flags TypeScript functions whose
cyclomatic complexity exceeds a configured maximum. This is the migrated
form of the retired built-in `complexity` engine rule (Iteration 15): the
scanner now emits findings directly and runs through the generic
user-defined sensor pipeline (`.backpressure/sensors/*.yaml`).

## Requirements

The scanner is a Python script and needs:

```
python -m pip install --user tree-sitter tree-sitter-typescript pyyaml
```

(Tested with tree-sitter 0.26.0 / tree-sitter-typescript 0.23.2 / pyyaml 6.x
on Python 3.13.) If Python or the packages are missing, the sensor fails
open: it reports `no-bin` or a parse failure and never blocks writes.

## Install (per repo)

```
New-Item -ItemType Directory -Force ".backpressure\sensors" | Out-Null
Copy-Item "sensors-examples\complexity\*" ".backpressure\sensors\"
```

Then edit `.backpressure/sensors/sensor.yaml`:

- Set `lifecycle.status: adopted` to make findings block (the shipped
  default is `status: draft`, i.e. violations advise at session idle).
- Tune `maxCyclomatic` in `.backpressure/sensors/complexity-rules.yaml`.

## Files

- `sensor.yaml` — the sensor definition (command, triggers, format mapping).
- `complexity_scan.py` — tree-sitter walker; counts decision nodes per
  function and emits `{"findings":[...]}` on stdout.
- `complexity-rules.yaml` — the threshold rules consumed by the scanner.
