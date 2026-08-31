import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseSemgrepJson, runSemgrepGate, runSemgrepRescan } from "./semgrep.ts";

const REAL_FIXTURE =
  '{"version":"1.174.0","results":[{"check_id":"C.Users.mail.AppData.Local.Temp.opencode.bp-recon.rules.no-eval","path":"C:\\\\Users\\\\mail\\\\target\\\\viol.ts","start":{"line":2,"col":13,"offset":44},"end":{"line":2,"col":24,"offset":55},"extra":{"message":"eval() is forbidden","metadata":{},"severity":"ERROR","fingerprint":"requires login","lines":"requires login","validation_state":"NO_VALIDATOR","engine_kind":"OSS"}}],"errors":[],"paths":{"scanned":[]},"time":{}}';

const EVAL_RULE =
  "rules:\n  - id: no-eval\n    languages: [typescript]\n    severity: ERROR\n    message: eval forbidden\n    pattern: 'eval(...)'\n";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "bp-test-root-"));
}

function normPath(p: string): string {
  return resolve(p.replace(/\\/g, "/")).replace(/\\/g, "/").toLowerCase();
}

function semgrepBinPath(): string {
  return (
    process.env.BACKPRESSURE_SEMGREP_BIN ||
    join(process.env.APPDATA ?? "", "Python", "Python313", "Scripts", "pysemgrep.exe")
  );
}

describe("parseSemgrepJson", () => {
  test("maps the observed semgrep JSON shape", () => {
    const parsed = parseSemgrepJson(REAL_FIXTURE);
    expect(parsed.unparseable).toBe(false);
    expect(parsed.errors).toBe(0);
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0].checkId).toBe("no-eval");
    expect(parsed.findings[0].severity).toBe("ERROR");
    expect(parsed.findings[0].message).toBe("eval() is forbidden");
    expect(parsed.findings[0].startLine).toBe(2);
  });

  test("flattens backpressure metadata", () => {
    const json = JSON.stringify({
      results: [
        {
          check_id: "C.x.rules.no-eval",
          start: { line: 1 },
          extra: {
            severity: "ERROR",
            message: "m",
            metadata: { backpressure: { why: "why text", instead: "instead text", appealable: false } },
          },
        },
      ],
      errors: [],
    });
    const parsed = parseSemgrepJson(json);
    expect(parsed.findings[0].why).toBe("why text");
    expect(parsed.findings[0].instead).toBe("instead text");
    expect(parsed.findings[0].appealable).toBe(false);
  });

  test("malformed JSON is unparseable and fail-open", () => {
    const parsed = parseSemgrepJson("{not json");
    expect(parsed.unparseable).toBe(true);
    expect(parsed.findings).toEqual([]);
    expect(parsed.errors).toBe(-1);
  });

  test("non-array results tolerated", () => {
    const parsed = parseSemgrepJson(JSON.stringify({ results: { nope: 1 }, errors: [] }));
    expect(parsed.findings).toEqual([]);
    expect(parsed.unparseable).toBe(false);
  });

  test("severity casing normalized and missing defaults to INFO", () => {
    const parsed = parseSemgrepJson(
      JSON.stringify({
        results: [
          { check_id: "C.x.a", start: {}, extra: { severity: "error", message: "a" } },
          { check_id: "C.x.b", start: {}, extra: { message: "b" } },
        ],
        errors: [],
      })
    );
    expect(parsed.findings[0].severity).toBe("ERROR");
    expect(parsed.findings[1].severity).toBe("INFO");
  });

  test("errors count populated", () => {
    const parsed = parseSemgrepJson(
      JSON.stringify({ results: [], errors: [{ type: "SemgrepError", message: "bad yaml" }] })
    );
    expect(parsed.errors).toBe(1);
  });

  test("bp.mode advise flattens to advise", () => {
    const parsed = parseSemgrepJson(
      JSON.stringify({
        results: [
          {
            check_id: "C.x.rules.r1",
            start: { line: 1 },
            extra: { severity: "ERROR", message: "m", metadata: { backpressure: { mode: "advise" } } },
          },
        ],
        errors: [],
      })
    );
    expect(parsed.findings[0].mode).toBe("advise");
  });

  test("bp.mode block flattens to block", () => {
    const parsed = parseSemgrepJson(
      JSON.stringify({
        results: [
          {
            check_id: "C.x.rules.r1",
            start: { line: 1 },
            extra: { severity: "ERROR", message: "m", metadata: { backpressure: { mode: "BLOCK" } } },
          },
        ],
        errors: [],
      })
    );
    expect(parsed.findings[0].mode).toBe("block");
  });

  test("bp.mode typo flattens to undefined (fail closed)", () => {
    const parsed = parseSemgrepJson(
      JSON.stringify({
        results: [
          {
            check_id: "C.x.rules.r1",
            start: { line: 1 },
            extra: { severity: "ERROR", message: "m", metadata: { backpressure: { mode: "advis" } } },
          },
        ],
        errors: [],
      })
    );
    expect(parsed.findings[0].mode).toBeUndefined();
  });
});

describe("runSemgrepGate", () => {
  test("no-rules dir returns [] without spawn", async () => {
    const root = tmpRoot();
    const result = await runSemgrepGate(
      { tool: "write", paths: [join(root, "engine", "x.ts")], workdir: root, content: "export const x = 1;" },
      { protectedRoot: root, qualityRoots: [join(root, "engine")] }
    );
    expect(result.ran).toBe(false);
    expect(result.reason).toBe("no-rules");
    expect(result.findings).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  test("out-of-scope returns [] without spawn", async () => {
    const root = tmpRoot();
    const rulesDir = join(root, ".backpressure", "rules");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, "no-eval.yaml"), EVAL_RULE);
    const result = await runSemgrepGate(
      { tool: "write", paths: [join(root, "other", "x.ts")], workdir: root, content: "const x = eval('1');" },
      { protectedRoot: root, qualityRoots: [join(root, "engine")] }
    );
    expect(result.ran).toBe(false);
    expect(result.reason).toBe("out-of-scope");
    rmSync(root, { recursive: true, force: true });
  });

  test("in-scope violating write is scanned (skip if no semgrep bin)", async () => {
    const bin =
      process.env.BACKPRESSURE_SEMGREP_BIN ||
      join(process.env.APPDATA ?? "", "Python", "Python313", "Scripts", "pysemgrep.exe");
    if (!existsSync(bin)) return;
    const root = tmpRoot();
    const rulesDir = join(root, ".backpressure", "rules");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, "no-eval.yaml"), EVAL_RULE);
    const result = await runSemgrepGate(
      { tool: "write", paths: [join(root, "engine", "x.ts")], workdir: root, content: "export const x = eval('1+1');" },
      { protectedRoot: root, qualityRoots: [join(root, "engine")] }
    );
    expect(result.ran).toBe(true);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings[0].checkId).toBe("no-eval");
    expect(existsSync(join(root, "engine", "x.ts"))).toBe(false);
    const slug = String(root).replace(/[^a-zA-Z0-9._-]/g, "_");
    expect(existsSync(join(tmpdir(), "opencode", "bp-scan", slug))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test("no-candidate returns without spawn", async () => {
    const root = tmpRoot();
    const rulesDir = join(root, ".backpressure", "rules");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, "no-eval.yaml"), EVAL_RULE);
    const result = await runSemgrepGate(
      { tool: "write", paths: [join(root, "engine", "x.ts")], workdir: root, content: "" },
      { protectedRoot: root, qualityRoots: [join(root, "engine")] }
    );
    expect(result.ran).toBe(false);
    expect(result.reason).toBe("no-candidate");
    rmSync(root, { recursive: true, force: true });
  });

  test("config.rulesDir override consumed (fixture + no-bin short-circuit)", async () => {
    const root = tmpRoot();
    const customRules = join(root, "custom-rules");
    mkdirSync(customRules, { recursive: true });
    writeFileSync(join(customRules, "no-eval.yaml"), EVAL_RULE);
    const prev = process.env.BACKPRESSURE_SEMGREP_BIN;
    process.env.BACKPRESSURE_SEMGREP_BIN = join(root, "nonexistent-bin.exe");
    try {
      const result = await runSemgrepGate(
        { tool: "write", paths: [join(root, "engine", "x.ts")], workdir: root, content: "const x = eval('1+1');" },
        { protectedRoot: root, qualityRoots: [join(root, "engine")], rulesDir: customRules }
      );
      expect(result.reason).toBe("no-bin");
    } finally {
      if (prev === undefined) delete process.env.BACKPRESSURE_SEMGREP_BIN;
      else process.env.BACKPRESSURE_SEMGREP_BIN = prev;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("bp.status flattening", () => {
  const parseWith = (bp: Record<string, unknown>) =>
    parseSemgrepJson(
      JSON.stringify({
        results: [
          {
            check_id: "C.x.r1",
            start: { line: 1 },
            extra: { severity: "ERROR", message: "m", metadata: { backpressure: bp } },
          },
        ],
        errors: [],
      })
    ).findings[0];

  test("status lowercase passthrough, absent/non-string undefined", () => {
    expect(parseWith({ status: "draft" }).status).toBe("draft");
    expect(parseWith({ status: "adopted" }).status).toBe("adopted");
    expect(parseWith({ status: "Draft" }).status).toBe("draft");
    expect(parseWith({ status: "Draftt" }).status).toBe("draftt");
    expect(parseWith({}).status).toBeUndefined();
    expect(parseWith({ status: 3 }).status).toBeUndefined();
  });

  test("status and mode flatten independently (resolution stays in core)", () => {
    const a = parseWith({ status: "draft", mode: "block" });
    expect(a.status).toBe("draft");
    expect(a.mode).toBe("block");
    const b = parseWith({ status: "adopted" });
    expect(b.status).toBe("adopted");
    expect(b.mode).toBeUndefined();
    const c = parseWith({ mode: "advise" });
    expect(c.status).toBeUndefined();
    expect(c.mode).toBe("advise");
  });

  test("status-absent regression pin (legacy shape unchanged)", () => {
    const parsed = parseSemgrepJson(REAL_FIXTURE);
    expect(parsed.findings[0].status).toBeUndefined();
    expect(parsed.findings[0].mode).toBeUndefined();
    expect(parsed.findings[0].checkId).toBe("no-eval");
    expect(parsed.findings[0].severity).toBe("ERROR");
  });
});

describe("runSemgrepRescan", () => {
  test("no-files short-circuits without spawn", async () => {
    const root = tmpRoot();
    const result = await runSemgrepRescan([], {
      protectedRoot: root,
      qualityRoots: [join(root, "engine")],
    });
    expect(result.ran).toBe(false);
    expect(result.findings).toEqual([]);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    rmSync(root, { recursive: true, force: true });
  });

  test("no-rules dir short-circuits", async () => {
    const root = tmpRoot();
    mkdirSync(join(root, "engine"), { recursive: true });
    const real = join(root, "engine", "a.ts");
    writeFileSync(real, "const x = eval('1');");
    const result = await runSemgrepRescan([normPath(real)], {
      protectedRoot: root,
      qualityRoots: [join(root, "engine")],
    });
    expect(result.ran).toBe(false);
    expect(result.reason).toBe("no-rules");
    expect(result.findings).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  test("no-bin short-circuits with rules and files present", async () => {
    const root = tmpRoot();
    const rulesDir = join(root, ".backpressure", "rules");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, "no-eval.yaml"), EVAL_RULE);
    mkdirSync(join(root, "engine"), { recursive: true });
    const real = join(root, "engine", "a.ts");
    writeFileSync(real, "const x = eval('1');");
    const prev = process.env.BACKPRESSURE_SEMGREP_BIN;
    process.env.BACKPRESSURE_SEMGREP_BIN = join(root, "nonexistent-bin.exe");
    try {
      const result = await runSemgrepRescan([normPath(real)], {
        protectedRoot: root,
        qualityRoots: [join(root, "engine")],
      });
      expect(result.ran).toBe(false);
      expect(result.reason).toBe("no-bin");
    } finally {
      if (prev === undefined) delete process.env.BACKPRESSURE_SEMGREP_BIN;
      else process.env.BACKPRESSURE_SEMGREP_BIN = prev;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("missing-on-disk files skipped silently (skip if no semgrep bin)", async () => {
    if (!existsSync(semgrepBinPath())) return;
    const root = tmpRoot();
    const rulesDir = join(root, ".backpressure", "rules");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, "no-eval.yaml"), EVAL_RULE);
    mkdirSync(join(root, "engine"), { recursive: true });
    const real = join(root, "engine", "keep.ts");
    writeFileSync(real, "const x = eval('1+1');");
    const missing = normPath(join(root, "engine", "gone.ts"));
    const result = await runSemgrepRescan([normPath(real), missing], {
      protectedRoot: root,
      qualityRoots: [join(root, "engine")],
    });
    expect(result.ran).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].path).toBe(normPath(real));
    expect(result.findings[0].checkId).toBe("no-eval");
    rmSync(root, { recursive: true, force: true });
  }, 30000);

  test("multi-file rescan maps findings to real normalized paths (skip if no semgrep bin)", async () => {
    if (!existsSync(semgrepBinPath())) return;
    const root = tmpRoot();
    const rulesDir = join(root, ".backpressure", "rules");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, "no-eval.yaml"), EVAL_RULE);
    mkdirSync(join(root, "engine"), { recursive: true });
    const clean = join(root, "engine", "clean.ts");
    writeFileSync(clean, "export const ok = 1;");
    const dirty = join(root, "engine", "dirty.ts");
    writeFileSync(dirty, "const x = eval('1+1');");
    const result = await runSemgrepRescan([normPath(clean), normPath(dirty)], {
      protectedRoot: root,
      qualityRoots: [join(root, "engine")],
    });
    expect(result.ran).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].path).toBe(normPath(dirty));
    expect(result.findings[0].checkId).toBe("no-eval");
    expect(result.durationMs).toBeGreaterThan(0);
    const slug = String(root).replace(/[^a-zA-Z0-9._-]/g, "_");
    expect(existsSync(join(tmpdir(), "opencode", "bp-scan", slug))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  }, 30000);
});