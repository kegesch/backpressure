import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { globMatch, type ToolCallDescription } from "./core.ts";
import {
  MAX_SENSORS,
  loadSensors,
  mapSeverity,
  normalizeSensorConfig,
  parseEslintFormat,
  parseJsonFormat,
  parseRegexFormat,
  parseSensorYaml,
  runSensors,
  runSensorsRescan,
  templatePlaceholders,
  type SensorConfig,
} from "./sensors.ts";

const ROOTS: string[] = [];
afterAll(() => {
  for (const r of ROOTS) {
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {
    }
  }
});

function makeRepo(): { root: string; sensorsDir: string } {
  const root = mkdtempSync(join(tmpdir(), "opencode", "bp-st-"));
  ROOTS.push(root);
  const sensorsDir = join(root, ".backpressure", "sensors");
  mkdirSync(sensorsDir, { recursive: true });
  return { root, sensorsDir };
}

function writeSensor(dir: string, name: string, text: string): string {
  const file = join(dir, name);
  writeFileSync(file, text, "utf8");
  return file;
}

function cfg(root: string, sensorsDir: string): { protectedRoot: string; sensorsDir: string } {
  return { protectedRoot: root, sensorsDir };
}

function call(root: string, rel: string, over: Partial<ToolCallDescription> = {}): ToolCallDescription {
  return {
    tool: "write",
    paths: [join(root, rel)],
    workdir: root,
    content: "const x = 1;\n",
    ...over,
  };
}

const slug = (p: string): string => p.replace(/[^a-zA-Z0-9._-]/g, "_");
const normReal = (p: string): string => resolve(p.replace(/\\/g, "/")).replace(/\\/g, "/").toLowerCase();

const EMIT_ONE = "console.log(JSON.stringify({findings:[{ruleId:'r1',line:3,message:'m1',severity:'ERROR'}]}))";
const EMIT_EMPTY = "console.log('{\"findings\":[]}')";

function stubYaml(id: string, script: string, extra = ""): string {
  return (
    `id: ${id}\n` +
    `command: ["bun", "-e", "${script}"]\n` +
    `triggers:\n  include: ["src/**"]\n` +
    `format:\n  type: json\n  findingsPath: "findings"\n` +
    `severity:\n  map: { ERROR: ERROR, WARNING: WARNING }\n  default: INFO\n` +
    extra
  );
}

function mkCfg(dir: string, name: string, text: string): SensorConfig {
  const file = writeSensor(dir, name, text);
  const parsed = parseSensorYaml(readFileSync(file, "utf8"));
  if (!parsed.ok) throw new Error(parsed.error);
  const normalized = normalizeSensorConfig(parsed.value, file, dirname(file));
  if (!normalized.ok) throw new Error(normalized.error);
  return normalized.config;
}

describe("sensor yaml parser (pure)", () => {
  test("golden parse of the full schema subset", () => {
    const text = [
      "# top comment",
      "id: eslint",
      'description: "ESLint as a backpressure sensor"',
      'command: ["npx", "--no-install", "eslint", "--format", "json", "{file}"]',
      "timeoutMs: 20000",
      'cwd: "{workdir}"',
      "env: { NODE_ENV: production }",
      "triggers:",
      '  include: ["src/**/*.ts", "engine/**/*.ts"]',
      '  exclude: ["**/*.test.ts"]',
      "  tools: [write]",
      "format:",
      "  type: json",
      '  findingsPath: "results"',
      "  fields:",
      "    ruleId: ruleId",
      "    path: filePath",
      "    line: line",
      "    message: message",
      "    severity: severity",
      "exitCodes:",
      "  findings: [0, 1]",
      "severity:",
      '  map: { "2": ERROR, "1": WARNING }',
      "  default: INFO",
      "defaults:",
      '  why: ""',
      '  instead: ""',
      "  appealable: true",
      "lifecycle:",
      "  status: adopted",
      "  mode: block",
      "ratchet: {}",
    ].join("\n");
    const parsed = parseSensorYaml(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({
      id: "eslint",
      description: "ESLint as a backpressure sensor",
      command: ["npx", "--no-install", "eslint", "--format", "json", "{file}"],
      timeoutMs: "20000",
      cwd: "{workdir}",
      env: { NODE_ENV: "production" },
      triggers: {
        include: ["src/**/*.ts", "engine/**/*.ts"],
        exclude: ["**/*.test.ts"],
        tools: ["write"],
      },
      format: {
        type: "json",
        findingsPath: "results",
        fields: {
          ruleId: "ruleId",
          path: "filePath",
          line: "line",
          message: "message",
          severity: "severity",
        },
      },
      exitCodes: { findings: ["0", "1"] },
      severity: { map: { "2": "ERROR", "1": "WARNING" }, default: "INFO" },
      defaults: { why: "", instead: "", appealable: "true" },
      lifecycle: { status: "adopted", mode: "block" },
      ratchet: {},
    });
  });

  test("hash inside quoted string is not a comment", () => {
    const parsed = parseSensorYaml('id: a\ndescription: "hash # not comment"');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({ id: "a", description: "hash # not comment" });
  });

  test("malformed indentation fails closed", () => {
    const parsed = parseSensorYaml("triggers:\n   include: [a]");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("indentation");
  });

  test("unclosed quote fails closed", () => {
    const parsed = parseSensorYaml('id: "open');
    expect(parsed.ok).toBe(false);
  });

  test("over-indented scalar continuation fails closed", () => {
    const parsed = parseSensorYaml("id: a\n  extra: b");
    expect(parsed.ok).toBe(false);
  });

  test("empty input fails closed", () => {
    expect(parseSensorYaml("").ok).toBe(false);
    expect(parseSensorYaml("# only a comment\n").ok).toBe(false);
  });
});

describe("normalizeSensorConfig (pure)", () => {
  test("invalid id rejected", () => {
    const parsed = parseSensorYaml('id: Bad_ID\ncommand: ["x"]\nformat:\n  type: json');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const n = normalizeSensorConfig(parsed.value, "f.yaml", "d");
    expect(n.ok).toBe(false);
    if (n.ok) return;
    expect(n.error).toContain("id");
  });

  test("missing command rejected", () => {
    const parsed = parseSensorYaml("id: a\nformat:\n  type: json");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(normalizeSensorConfig(parsed.value, "f.yaml", "d").ok).toBe(false);
  });

  test("unknown format.type rejected", () => {
    const parsed = parseSensorYaml('id: a\ncommand: ["x"]\nformat:\n  type: csv');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(normalizeSensorConfig(parsed.value, "f.yaml", "d").ok).toBe(false);
  });

  test("regex format requires pattern", () => {
    const parsed = parseSensorYaml('id: a\ncommand: ["x"]\nformat:\n  type: regex');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const n = normalizeSensorConfig(parsed.value, "f.yaml", "d");
    expect(n.ok).toBe(false);
    if (n.ok) return;
    expect(n.error).toContain("pattern");
  });

  test("eslint preset defaults severity map and exit codes", () => {
    const parsed = parseSensorYaml('id: a\ncommand: ["x"]\nformat:\n  type: preset:eslint-json');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const n = normalizeSensorConfig(parsed.value, "f.yaml", "d");
    expect(n.ok).toBe(true);
    if (!n.ok) return;
    expect(n.config.severityMap).toEqual({ "2": "ERROR", "1": "WARNING" });
    expect(n.config.exitCodes).toEqual([0, 1]);
    expect(n.config.severityDefault).toBe("INFO");
    expect(n.config.tools).toEqual(["write"]);
  });

  test("unknown trigger tool rejected", () => {
    const parsed = parseSensorYaml(
      'id: a\ncommand: ["x"]\ntriggers:\n  tools: [bash]\nformat:\n  type: json'
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(normalizeSensorConfig(parsed.value, "f.yaml", "d").ok).toBe(false);
  });

  test("ratchet section parsed but ignored (reserved iter-16)", () => {
    const parsed = parseSensorYaml(
      'id: a\ncommand: ["x"]\nformat:\n  type: json\nratchet:\n  baseline: "x.json"'
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const n = normalizeSensorConfig(parsed.value, "f.yaml", "d");
    expect(n.ok).toBe(true);
    if (!n.ok) return;
    expect("ratchet" in n.config).toBe(false);
  });
});

describe("json format parser (pure)", () => {
  const base = {
    id: "j",
    command: ["x"],
    include: [],
    exclude: [],
    tools: ["write"],
    formatType: "json",
    findingsPath: "",
    fields: { ruleId: "ruleId", path: "path", line: "line", message: "message", severity: "severity" },
    exitCodes: [0],
    severityMap: {},
    severityDefault: "INFO",
    defaults: {},
    lifecycle: {},
    sensorDir: "d",
    file: "f.yaml",
  } as unknown as SensorConfig;

  test("findingsPath dot-path descends to flat array", () => {
    const out = parseJsonFormat(
      '{"result":{"items":[{"ruleId":"r","path":"p","line":1,"message":"m","severity":"ERROR"}]}}',
      { ...base, findingsPath: "result.items" }
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.items).toHaveLength(1);
    expect(out.items[0].ruleId).toBe("r");
  });

  test("custom fields mapping", () => {
    const out = parseJsonFormat(
      '[{"id":"n","loc":{"file":"f.ts"},"row":"7","text":"boom","lvl":"ERROR"}]',
      {
        ...base,
        fields: { ruleId: "id", path: "loc.file", line: "row", message: "text", severity: "lvl" },
      }
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.items[0]).toEqual({ ruleId: "n", path: "f.ts", line: 7, message: "boom", severity: "ERROR" });
  });

  test("missing fields degrade to undefined", () => {
    const out = parseJsonFormat('[{"ruleId":"r"}]', base);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.items[0].ruleId).toBe("r");
    expect(out.items[0].path).toBeUndefined();
    expect(out.items[0].line).toBeUndefined();
    expect(out.items[0].message).toBeUndefined();
    expect(out.items[0].severity).toBeUndefined();
  });

  test("unparseable stdout returns ok false", () => {
    expect(parseJsonFormat("not json", base).ok).toBe(false);
  });

  test("non-array findingsPath target returns ok false", () => {
    expect(parseJsonFormat('{"result":{"items":{}}}', { ...base, findingsPath: "result.items" }).ok).toBe(
      false
    );
  });
});

describe("eslint preset parser (pure)", () => {
  test("flattens top array of filePath/messages", () => {
    const stdout = JSON.stringify([
      {
        filePath: "C:/x/a.ts",
        messages: [
          { ruleId: "no-eval", line: 2, message: "eval", severity: 2 },
          { ruleId: "no-unused", line: 5, message: "unused", severity: 1 },
        ],
      },
      { filePath: "C:/x/b.ts", messages: [] },
    ]);
    const out = parseEslintFormat(stdout);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.items).toHaveLength(2);
    expect(out.items[0]).toEqual({
      ruleId: "no-eval",
      path: "C:/x/a.ts",
      line: 2,
      message: "eval",
      severity: 2,
    });
  });

  test("numeric severity maps 2 to ERROR and 1 to WARNING, default INFO", () => {
    const parsed = parseSensorYaml('id: a\ncommand: ["x"]\nformat:\n  type: preset:eslint-json');
    if (!parsed.ok) throw new Error(parsed.error);
    const n = normalizeSensorConfig(parsed.value, "f.yaml", "d");
    if (!n.ok) throw new Error(n.error);
    expect(mapSeverity(n.config, 2)).toBe("ERROR");
    expect(mapSeverity(n.config, 1)).toBe("WARNING");
    expect(mapSeverity(n.config, 3)).toBe("INFO");
    expect(mapSeverity(n.config, undefined)).toBe("INFO");
  });
});

describe("regex parser (pure)", () => {
  const rc = (pattern: string): SensorConfig =>
    ({
      id: "r",
      command: ["x"],
      include: [],
      exclude: [],
      tools: ["write"],
      formatType: "regex",
      findingsPath: "",
      fields: { ruleId: "ruleId", path: "path", line: "line", message: "message", severity: "severity" },
      pattern,
      exitCodes: [0],
      severityMap: { ERROR: "ERROR", WARNING: "WARNING" },
      severityDefault: "INFO",
      defaults: {},
      lifecycle: {},
      sensorDir: "d",
      file: "f.yaml",
    }) as unknown as SensorConfig;

  test("named groups extracted line-by-line with severityGroup mapping", () => {
    const pattern =
      "^(?<file>[^:]+):(?<line>\\d+): (?<message>.+) \\[(?<ruleId>[^\\]]+)\\] (?<severityGroup>\\w+)$";
    const out = parseRegexFormat(
      "noise line\nsrc/a.ts:7: boom [E001] ERROR\nsrc/b.ts:9: warn [W002] WARNING\n",
      rc(pattern)
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.items).toHaveLength(2);
    expect(out.items[0].path).toBe("src/a.ts");
    expect(out.items[0].line).toBe(7);
    expect(out.items[0].message).toBe("boom");
    expect(out.items[0].ruleId).toBe("E001");
    expect(out.items[0].severity).toBe("ERROR");
    expect(out.items[1].severity).toBe("WARNING");
  });

  test("missing groups and non-matching lines degrade", () => {
    const pattern = "^(?<file>[^:]+):(?<line>\\d+): (?<message>.+)$";
    const out = parseRegexFormat("no match here\nsrc/a.ts:7: boom\n", rc(pattern));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.items).toHaveLength(1);
    expect(out.items[0].ruleId).toBeUndefined();
    expect(out.items[0].severity).toBeUndefined();
  });
});

describe("mapSeverity + templatePlaceholders + globMatch (pure)", () => {
  const parsed = parseSensorYaml('id: a\ncommand: ["x"]\nformat:\n  type: json');
  const c = (() => {
    if (!parsed.ok) throw new Error(parsed.error);
    const n = normalizeSensorConfig(parsed.value, "f.yaml", "d");
    if (!n.ok) throw new Error(n.error);
    return n.config;
  })();

  test("severity default applies when raw unmapped", () => {
    expect(mapSeverity(c, "banana")).toBe("INFO");
    expect(mapSeverity(c, undefined)).toBe("INFO");
    expect(mapSeverity({ ...c, severityMap: { high: "ERROR" }, severityDefault: "WARNING" }, "low")).toBe(
      "WARNING"
    );
  });

  test("numeric raw severity uses stringified map keys", () => {
    expect(mapSeverity({ ...c, severityMap: { "2": "ERROR" } }, 2)).toBe("ERROR");
  });

  test("all six placeholders replaced", () => {
    const out = templatePlaceholders("{file}|{relPath}|{fileName}|{root}|{sensorDir}|{workdir}", {
      file: "F",
      relPath: "R",
      fileName: "N",
      root: "O",
      sensorDir: "S",
      workdir: "W",
    });
    expect(out).toBe("F|R|N|O|S|W");
  });

  test("unknown placeholder untouched", () => {
    expect(templatePlaceholders("{keep}", { file: "F" })).toBe("{keep}");
  });

  test("globMatch 3-shape: dir/**, **/*.ext, exact", () => {
    expect(globMatch("engine/**", "engine/a/b.ts")).toBe(true);
    expect(globMatch("engine/**", "engineer/a.ts")).toBe(false);
    expect(globMatch("**/*.test.ts", "src/a.test.ts")).toBe(true);
    expect(globMatch("**/*.test.ts", "src/sub/b.test.ts")).toBe(true);
    expect(globMatch("**/*.test.ts", "src/a.ts")).toBe(false);
    expect(globMatch("src/a.ts", "src/a.ts")).toBe(true);
    expect(globMatch("src/a.ts", "src/b.ts")).toBe(false);
  });
});

describe("loadSensors", () => {
  test("sorted discovery with json escape hatch", () => {
    const { root, sensorsDir } = makeRepo();
    writeSensor(sensorsDir, "b.yaml", stubYaml("beta", EMIT_ONE));
    writeSensor(
      sensorsDir,
      "a.json",
      JSON.stringify({
        id: "alpha",
        command: ["bun", "-e", EMIT_ONE],
        triggers: { include: ["src/**"] },
        format: { type: "json" },
      })
    );
    const { sensors, errors } = loadSensors(cfg(root, sensorsDir));
    expect(errors).toEqual([]);
    expect(sensors.map((s) => s.id)).toEqual(["alpha", "beta"]);
  });

  test("broken file inert with error, others unaffected", () => {
    const { root, sensorsDir } = makeRepo();
    writeSensor(sensorsDir, "bad.yaml", "id: \"open\ncommand: [x]");
    writeSensor(sensorsDir, "good.yaml", stubYaml("good", EMIT_ONE));
    const { sensors, errors } = loadSensors(cfg(root, sensorsDir));
    expect(sensors.map((s) => s.id)).toEqual(["good"]);
    expect(errors).toHaveLength(1);
    expect(errors[0].file.endsWith("bad.yaml")).toBe(true);
    expect(typeof errors[0].error).toBe("string");
  });

  test("missing dir returns zero sensors and zero errors", () => {
    const { root, sensorsDir } = makeRepo();
    const { sensors, errors } = loadSensors(cfg(root, join(sensorsDir, "nope")));
    expect(sensors).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("auxiliary data yaml without top-level id is skipped silently", () => {
    const { root, sensorsDir } = makeRepo();
    writeSensor(sensorsDir, "data.yaml", "rules:\n  - id: nested\n    max: 2\n");
    const { sensors, errors } = loadSensors(cfg(root, sensorsDir));
    expect(sensors).toEqual([]);
    expect(errors).toEqual([]);
  });
});

describe("runSensors execution", () => {
  test("end-to-end finding carries sensorId, toolRule, checkId and lifecycle stamps", async () => {
    const { root, sensorsDir } = makeRepo();
    writeSensor(
      sensorsDir,
      "stub.yaml",
      stubYaml("stub", EMIT_ONE, "lifecycle:\n  status: draft\n  mode: block\n")
    );
    const result = await runSensors(call(root, "src/a.ts"), cfg(root, sensorsDir));
    expect(result.configErrors).toEqual([]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].ran).toBe(true);
    expect(result.entries[0].findings).toHaveLength(1);
    const f = result.entries[0].findings[0];
    expect(f.checkId).toBe("r1");
    expect(f.sensorId).toBe("stub");
    expect(f.toolRule).toBe("r1");
    expect(f.severity).toBe("ERROR");
    expect(f.startLine).toBe(3);
    expect(f.status).toBe("draft");
    expect(f.mode).toBe("block");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].path).toBe(normReal(join(root, "src", "a.ts")));
  });

  test("exit 0 default parses findings", async () => {
    const { root, sensorsDir } = makeRepo();
    writeSensor(sensorsDir, "stub.yaml", stubYaml("stub", EMIT_ONE));
    const result = await runSensors(call(root, "src/a.ts"), cfg(root, sensorsDir));
    expect(result.entries[0].ran).toBe(true);
    expect(result.entries[0].findings).toHaveLength(1);
    expect(result.entries[0].reason).toBeUndefined();
  });

  test("exit 1 with findings parses when listed in exitCodes.findings", async () => {
    const { root, sensorsDir } = makeRepo();
    const script = "console.log(JSON.stringify({findings:[{ruleId:'r1',message:'m1',severity:'WARNING'}]})); process.exit(1)";
    writeSensor(
      sensorsDir,
      "stub.yaml",
      stubYaml("stub", script, "exitCodes:\n  findings: [0, 1]\n")
    );
    const result = await runSensors(call(root, "src/a.ts"), cfg(root, sensorsDir));
    expect(result.entries[0].ran).toBe(true);
    expect(result.entries[0].findings).toHaveLength(1);
    expect(result.entries[0].findings[0].severity).toBe("WARNING");
  });

  test("exit 2 fails open with empty findings even when stdout parses", async () => {
    const { root, sensorsDir } = makeRepo();
    const script = "console.log(JSON.stringify({findings:[{ruleId:'r1',message:'m1',severity:'ERROR'}]})); process.exit(2)";
    writeSensor(sensorsDir, "stub.yaml", stubYaml("stub", script));
    const result = await runSensors(call(root, "src/a.ts"), cfg(root, sensorsDir));
    expect(result.entries[0].ran).toBe(true);
    expect(result.entries[0].reason).toBe("exit:2");
    expect(result.entries[0].findings).toEqual([]);
    expect(result.findings).toEqual([]);
  });

  test("timeout kills and fails open with reason timeout", async () => {
    const { root, sensorsDir } = makeRepo();
    const script = "await new Promise(function (r) { setTimeout(r, 9000) })";
    writeSensor(sensorsDir, "stub.yaml", stubYaml("stub", script, "timeoutMs: 300\n"));
    const result = await runSensors(call(root, "src/a.ts"), cfg(root, sensorsDir));
    expect(result.entries[0].ran).toBe(true);
    expect(result.entries[0].reason).toBe("timeout");
    expect(result.entries[0].findings).toEqual([]);
  }, 15000);

  test("unparseable stdout fails open with reason unparseable", async () => {
    const { root, sensorsDir } = makeRepo();
    writeSensor(sensorsDir, "stub.yaml", stubYaml("stub", "console.log('not json at all')"));
    const result = await runSensors(call(root, "src/a.ts"), cfg(root, sensorsDir));
    expect(result.entries[0].ran).toBe(true);
    expect(result.entries[0].reason).toBe("unparseable");
    expect(result.entries[0].findings).toEqual([]);
  });

  test("bare binary missing on PATH fails open with no-bin", async () => {
    const { root, sensorsDir } = makeRepo();
    writeSensor(sensorsDir, "stub.yaml", stubYaml("stub", EMIT_ONE).replace("bun", "no-such-bin-iter15"));
    const result = await runSensors(call(root, "src/a.ts"), cfg(root, sensorsDir));
    expect(result.entries[0].ran).toBe(false);
    expect(result.entries[0].reason).toBe("no-bin");
    expect(result.findings).toEqual([]);
  });

  test("path-like binary missing fails open with no-bin", async () => {
    const { root, sensorsDir } = makeRepo();
    const yaml = stubYaml("stub", EMIT_ONE).replace('"bun"', `"C:/no/such/dir-iter15/tool.exe"`);
    writeSensor(sensorsDir, "stub.yaml", yaml);
    const result = await runSensors(call(root, "src/a.ts"), cfg(root, sensorsDir));
    expect(result.entries[0].ran).toBe(false);
    expect(result.entries[0].reason).toBe("no-bin");
  });

  test("spawn error on non-executable path fails open as timeout", async () => {
    const { root, sensorsDir } = makeRepo();
    const tool = join(root, "tool.txt");
    writeFileSync(tool, "not executable", "utf8");
    const yaml = stubYaml("stub", EMIT_ONE).replace('"bun"', `"${tool.replace(/\\/g, "/")}"`);
    writeSensor(sensorsDir, "stub.yaml", yaml);
    const result = await runSensors(call(root, "src/a.ts"), cfg(root, sensorsDir));
    expect(result.entries[0].ran).toBe(true);
    expect(result.entries[0].reason).toBe("timeout");
    expect(result.entries[0].findings).toEqual([]);
  });

  test("include dir/** matches nested paths", async () => {
    const { root, sensorsDir } = makeRepo();
    writeSensor(sensorsDir, "stub.yaml", stubYaml("stub", EMIT_ONE));
    const result = await runSensors(call(root, "src/sub/deep/a.ts"), cfg(root, sensorsDir));
    expect(result.entries[0].ran).toBe(true);
    expect(result.findings).toHaveLength(1);
  });

  test("exclude wins over include and non-matching sensor is silent", async () => {
    const { root, sensorsDir } = makeRepo();
    writeSensor(
      sensorsDir,
      "stub.yaml",
      stubYaml("stub", EMIT_ONE, "").replace('include: ["src/**"]', 'include: ["src/**"]\n  exclude: ["**/*.test.ts"]')
    );
    const excluded = await runSensors(call(root, "src/a.test.ts"), cfg(root, sensorsDir));
    expect(excluded.entries).toEqual([]);
    expect(excluded.findings).toEqual([]);
    const other = await runSensors(call(root, "lib/a.ts"), cfg(root, sensorsDir));
    expect(other.entries).toEqual([]);
  });

  test("edit tool skipped unless opt-in (no-candidate entry)", async () => {
    const { root, sensorsDir } = makeRepo();
    writeSensor(sensorsDir, "stub.yaml", stubYaml("stub", EMIT_ONE));
    const result = await runSensors(
      call(root, "src/a.ts", { tool: "edit", content: undefined, newText: "const y = 2;\n" }),
      cfg(root, sensorsDir)
    );
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].ran).toBe(false);
    expect(result.entries[0].reason).toBe("no-candidate");
  });

  test("edit opt-in via triggers.tools runs on edit", async () => {
    const { root, sensorsDir } = makeRepo();
    writeSensor(
      sensorsDir,
      "stub.yaml",
      stubYaml("stub", EMIT_ONE).replace("  include:", "  tools: [write, edit]\n  include:")
    );
    const result = await runSensors(
      call(root, "src/a.ts", { tool: "edit", content: undefined, newText: "const y = 2;\n" }),
      cfg(root, sensorsDir)
    );
    expect(result.entries[0].ran).toBe(true);
    expect(result.findings).toHaveLength(1);
  });

  test("MAX_SENSORS cap: excess sensors get sensor-cap entries", async () => {
    const { root, sensorsDir } = makeRepo();
    for (let i = 1; i <= 12; i++) {
      const id = `s${String(i).padStart(2, "0")}`;
      writeSensor(sensorsDir, `${id}.yaml`, stubYaml(id, EMIT_EMPTY));
    }
    const result = await runSensors(call(root, "src/a.ts"), cfg(root, sensorsDir));
    expect(result.entries).toHaveLength(12);
    expect(MAX_SENSORS).toBe(10);
    for (let i = 0; i < 10; i++) expect(result.entries[i].ran).toBe(true);
    expect(result.entries[10].ran).toBe(false);
    expect(result.entries[10].reason).toBe("sensor-cap");
    expect(result.entries[11].reason).toBe("sensor-cap");
  });

  test("scratch layout and all six placeholders end-to-end", async () => {
    const { root, sensorsDir } = makeRepo();
    const script =
      "console.log(JSON.stringify({findings:[{ruleId:'args',message:process.argv.slice(1).join('|')}]}))";
    const yaml =
      `id: echo\ncommand: ["bun", "-e", "${script}", "{file}", "{relPath}", "{fileName}", "{root}", "{sensorDir}", "{workdir}"]\n` +
      `triggers:\n  include: ["src/**"]\nformat:\n  type: json\n  findingsPath: "findings"\n`;
    writeSensor(sensorsDir, "echo.yaml", yaml);
    const result = await runSensors(call(root, "src/a.ts"), cfg(root, sensorsDir));
    expect(result.entries[0].ran).toBe(true);
    const parts = (result.entries[0].findings[0].message as string).split("|");
    expect(parts).toHaveLength(6);
    const fileNorm = parts[0].replace(/\\/g, "/");
    expect(fileNorm).toContain("/bp-sensors/");
    expect(fileNorm).toContain(`${slug(root)}/echo/`);
    expect(fileNorm).toContain("src/a.ts");
    expect(parts[1]).toBe("src/a.ts");
    expect(parts[2]).toBe("a.ts");
    expect(parts[3].replace(/\\/g, "/")).toContain(`/bp-sensors/${slug(root)}/echo`);
    expect(parts[4]).toBe(sensorsDir);
    expect(parts[5]).toBe(root);
  });

  test("scratch tree removed in finally even on failure", async () => {
    const { root, sensorsDir } = makeRepo();
    writeSensor(sensorsDir, "stub.yaml", stubYaml("stub", EMIT_ONE).replace("bun", "no-such-bin-iter15"));
    const scratchSensorDir = join(tmpdir(), "opencode", "bp-sensors", slug(root), "stub");
    await runSensors(call(root, "src/a.ts"), cfg(root, sensorsDir));
    expect(existsSync(scratchSensorDir)).toBe(false);
  });

  test("gate run removes the empty slug parent dir under bp-sensors", async () => {
    const { root, sensorsDir } = makeRepo();
    writeSensor(sensorsDir, "stub.yaml", stubYaml("stub", EMIT_ONE));
    const slugDir = join(tmpdir(), "opencode", "bp-sensors", slug(root));
    await runSensors(call(root, "src/a.ts"), cfg(root, sensorsDir));
    expect(existsSync(join(slugDir, "stub"))).toBe(false);
    expect(existsSync(slugDir)).toBe(false);
  });

  test("sensor env is additive over process.env", async () => {
    const { root, sensorsDir } = makeRepo();
    const script =
      "console.log(JSON.stringify({findings:[{ruleId:'env',message:(process.env.BP_STUB_MARKER || 'missing') + '|' + (process.env.PATH ? 'set' : 'unset')}]}))";
    writeSensor(sensorsDir, "stub.yaml", stubYaml("stub", script, "env: { BP_STUB_MARKER: hello }\n"));
    const result = await runSensors(call(root, "src/a.ts"), cfg(root, sensorsDir));
    expect(result.entries[0].findings[0].message).toBe("hello|set");
  });

  test("never throws when sensorsDir is a file or missing", async () => {
    const { root, sensorsDir } = makeRepo();
    const asFile = join(root, "afile.yaml");
    writeFileSync(asFile, "not a dir", "utf8");
    const r1 = await runSensors(call(root, "src/a.ts"), cfg(root, asFile));
    expect(r1.entries).toEqual([]);
    const r2 = await runSensors(call(root, "src/a.ts"), cfg(root, join(sensorsDir, "missing")));
    expect(r2.entries).toEqual([]);
    expect(r2.findings).toEqual([]);
  });

  test("config errors surface with file and error while good sensor still runs", async () => {
    const { root, sensorsDir } = makeRepo();
    writeSensor(sensorsDir, "0bad.yaml", "id: 9bad!\ncommand: [x]\nformat:\n  type: json");
    writeSensor(sensorsDir, "good.yaml", stubYaml("good", EMIT_ONE));
    const result = await runSensors(call(root, "src/a.ts"), cfg(root, sensorsDir));
    expect(result.configErrors).toHaveLength(1);
    expect(result.configErrors[0].file.endsWith("0bad.yaml")).toBe(true);
    expect(result.entries.some((e) => e.sensorId === "good" && e.ran)).toBe(true);
  });
});

describe("runSensorsRescan", () => {
  test("no files short-circuits", async () => {
    const { root, sensorsDir } = makeRepo();
    const result = await runSensorsRescan([], cfg(root, sensorsDir));
    expect(result.ran).toBe(false);
    expect(result.reason).toBe("no-files");
  });

  test("{file}-only sensor reports rescan-unsupported", async () => {
    const { root, sensorsDir } = makeRepo();
    writeSensor(sensorsDir, "f.yaml", stubYaml("f", EMIT_ONE));
    const target = join(root, "src", "a.ts");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(target, "x", "utf8");
    const result = await runSensorsRescan([target], cfg(root, sensorsDir));
    expect(result.ran).toBe(false);
    expect(result.reason).toBe("rescan-unsupported");
  });

  test("{root} sensor: single spawn with rel-to-real mapping", async () => {
    const { root, sensorsDir } = makeRepo();
    mkdirSync(join(root, "engine"), { recursive: true });
    const fa = join(root, "engine", "a.ts");
    const fb = join(root, "engine", "b.ts");
    writeFileSync(fa, "export const a = 1;\n", "utf8");
    writeFileSync(fb, "export const b = 2;\n", "utf8");
    const countFile = join(root, "count.txt").replace(/\\/g, "/");
    const script =
      "const fs = require('node:fs'); const r = process.argv[1]; fs.appendFileSync(process.argv[2], 'x'); const out = []; const walk = function (d) { const es = fs.readdirSync(d, { withFileTypes: true }); for (const e of es) { const p = d + '/' + e.name; if (e.isDirectory()) walk(p); else if (e.name.endsWith('.ts')) out.push(p); } }; walk(r); console.log(JSON.stringify({ findings: out.map(function (f) { return { ruleId: 'r', file: f, line: 1, message: 'm', severity: 'ERROR' }; }) }))";
    const yaml =
      `id: rootscan\ncommand: ["bun", "-e", "${script}", "{root}", "${countFile}"]\n` +
      `triggers:\n  include: ["engine/**"]\nformat:\n  type: json\n  findingsPath: "findings"\n  fields:\n    path: file\n`;
    writeSensor(sensorsDir, "rootscan.yaml", yaml);
    const result = await runSensorsRescan([fa, fb], cfg(root, sensorsDir));
    expect(result.ran).toBe(true);
    expect(result.configErrors).toEqual([]);
    expect(result.findings).toHaveLength(2);
    expect(readFileSync(countFile, "utf8")).toBe("x");
    const mapped = result.findings.map((f) => f.path).sort();
    expect(mapped).toEqual([normReal(fa), normReal(fb)].sort());
  });
});

const REPO = resolve(import.meta.dir, "..");
const HAS_PY = (() => {
  try {
    const p = Bun.spawnSync(["python", "-c", "import tree_sitter, tree_sitter_typescript"]);
    return p.exitCode === 0;
  } catch {
    return false;
  }
})();

const BIG_TS = [
  "export function iter14Big(x: number): number {",
  "  const a = x > 0 ? 1 : 2;",
  "  let b = a;",
  "  if (b > 0) b += 1;",
  "  if (b > 1) b += 2;",
  "  while (b < 20) b += 1;",
  "  for (let i = 0; i < 3; i++) b += i;",
  "  if (b > 3 && b < 30) b += 4;",
  "  switch (b) { case 1: b += 6; break; case 2: b += 7; break; default: break; }",
  "  try { b += 8; } catch { b -= 1; }",
  "  return b;",
  "}",
].join("\n");

describe("example sensor parity", () => {
  test.skipIf(!HAS_PY)(
    "complexity example through runSensors: CCN-11 message byte-equal",
    async () => {
      const { root } = makeRepo();
      const sensorsDir = join(REPO, "sensors-examples", "complexity");
      const result = await runSensors(call(root, "engine/big.ts", { content: BIG_TS }), cfg(root, sensorsDir));
      expect(result.configErrors).toEqual([]);
      const entry = result.entries.find((e) => e.sensorId === "complexity");
      expect(entry).toBeDefined();
      expect(entry!.ran).toBe(true);
      expect(entry!.findings).toHaveLength(1);
      expect(entry!.findings[0].checkId).toBe("engine-max-cyclomatic");
      expect(entry!.findings[0].message).toBe(
        "function 'iter14Big' cyclomatic complexity 11 exceeds max 10"
      );
      expect(entry!.findings[0].startLine).toBe(1);
      expect(entry!.findings[0].path).toBe(normReal(join(root, "engine", "big.ts")));
    },
    20000
  );
});
