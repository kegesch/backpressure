import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isCommitCommand,
  extractCommitMessage,
  extractCdTarget,
  extractAppeal,
  loadValidators,
  parseValidatorOutput,
  runValidator,
  parseBatchedOutput,
  validateCommit,
  formatBlockMessage,
  readValidatorState,
  getCommitContext,
  DEFAULT_VALIDATOR_STATE,
  type Validator,
  type CommitContext,
  type CommitExecutor,
} from "./commit-validators.ts";

function makeValidator(over: Partial<Validator> = {}): Validator {
  return {
    name: "v",
    description: "d",
    enabled: true,
    tier: 2,
    content: "rule body",
    path: "/tmp/v.md",
    ...over,
  };
}

const ctx: CommitContext = {
  diff: "",
  files: [],
  message: "",
  command: "git commit -m \"x\"",
  cwd: "/tmp",
};

describe("detection helpers", () => {
  test("isCommitCommand matches plain and cd-prefixed commits", () => {
    expect(isCommitCommand('git commit -m "x"')).toBe(true);
    expect(isCommitCommand("cd dir && git commit -m x")).toBe(true);
    expect(isCommitCommand("git status")).toBe(false);
    expect(isCommitCommand("gitcommit")).toBe(false);
  });

  test("extractCommitMessage handles double, single, and no quotes", () => {
    expect(extractCommitMessage('git commit -m "hello"')).toBe("hello");
    expect(extractCommitMessage("git commit -m 'hello'")).toBe("hello");
    expect(extractCommitMessage("git commit -m hello")).toBe("");
  });

  test("extractCdTarget returns target or null", () => {
    expect(extractCdTarget("cd src && git commit")).toBe("src");
    expect(extractCdTarget("git commit")).toBeNull();
  });

  test("extractAppeal present and absent", () => {
    expect(extractAppeal("msg [appeal: cohere]")).toBe("cohere");
    expect(extractAppeal("plain msg")).toBeNull();
  });
});

describe("loadValidators", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bp-validators-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, content: string) =>
    writeFileSync(join(dir, name), content, "utf8");

  test("parses frontmatter: name, description, tier, enabled default", () => {
    write(
      "a.md",
      `---
name: a
description: first
tier: 0
---

body`,
    );
    const vs = loadValidators([dir]);
    expect(vs).toHaveLength(1);
    expect(vs[0].name).toBe("a");
    expect(vs[0].description).toBe("first");
    expect(vs[0].tier).toBe(0);
    expect(vs[0].enabled).toBe(true);
    expect(vs[0].content).toBe("body");
  });

  test("default tier is 2 when absent", () => {
    write("a.md", `---\nname: a\n---\n\nbody`);
    expect(loadValidators([dir])[0].tier).toBe(2);
  });

  test("invalid tier coerces to 2", () => {
    write("a.md", `---\nname: a\ntier: 9\n---\n\nbody`);
    expect(loadValidators([dir])[0].tier).toBe(2);
    write("b.md", `---\nname: b\ntier: "x"\n---\n\nbody`);
    expect(loadValidators([dir]).find((v) => v.name === "b")?.tier).toBe(2);
  });

  test("enabled:false is skipped; override-disabled is skipped", () => {
    write("a.md", `---\nname: a\nenabled: false\n---\n\nbody`);
    write("b.md", `---\nname: b\n---\n\nbody`);
    const vs = loadValidators([dir], { b: { enabled: false } });
    expect(vs.map((v) => v.name)).toEqual([]);
  });

  test("non-.md files ignored", () => {
    write("a.md", `---\nname: a\n---\n\nbody`);
    write("b.txt", `---\nname: b\n---\n\nbody`);
    write("c", `---\nname: c\n---\n\nbody`);
    const vs = loadValidators([dir]);
    expect(vs.map((v) => v.name)).toEqual(["a"]);
  });

  test("missing dir tolerated", () => {
    expect(loadValidators([join(dir, "nope")])).toEqual([]);
  });

  test("no frontmatter derives name from filename with tier 2 defaults", () => {
    write("alpha.md", "plain body");
    const vs = loadValidators([dir]);
    expect(vs).toHaveLength(1);
    expect(vs[0].name).toBe("alpha");
    expect(vs[0].tier).toBe(2);
    expect(vs[0].enabled).toBe(true);
    expect(vs[0].description).toBe("");
    expect(vs[0].content).toBe("plain body");
  });

  test("readdir sorted for determinism", () => {
    write("z.md", `---\nname: z\n---\n\nbody`);
    write("a.md", `---\nname: a\n---\n\nbody`);
    write("m.md", `---\nname: m\n---\n\nbody`);
    const vs = loadValidators([dir]);
    expect(vs.map((v) => v.name)).toEqual(["a", "m", "z"]);
  });
});

describe("parseValidatorOutput", () => {
  test("pure ACK", () => {
    expect(parseValidatorOutput('{"decision":"ACK"}')).toEqual({
      decision: "ACK",
    });
  });

  test("NACK with reason", () => {
    expect(parseValidatorOutput('{"decision":"NACK","reason":"no"}')).toEqual({
      decision: "NACK",
      reason: "no",
    });
  });

  test("prose-wrapped JSON", () => {
    const out = 'Sure! {"decision":"NACK","reason":"bad"} hope that helps';
    expect(parseValidatorOutput(out)).toEqual({ decision: "NACK", reason: "bad" });
  });

  test("garbage yields invalid NACK", () => {
    expect(parseValidatorOutput("not json at all")).toEqual({
      decision: "NACK",
      reason: "validator returned invalid response (no ACK decision)",
    });
  });

  test("MAYBE decision is invalid", () => {
    expect(parseValidatorOutput('{"decision":"MAYBE"}')).toEqual({
      decision: "NACK",
      reason: "validator returned invalid response (no ACK decision)",
    });
  });
});

describe("runValidator", () => {
  const v = makeValidator({ name: "dead-code", tier: 2 });

  test("ACK on first try", async () => {
    const calls: string[] = [];
    const exec: CommitExecutor = async () => {
      calls.push("x");
      return '{"decision":"ACK"}';
    };
    const res = await runValidator(v, ctx, exec);
    expect(res).toEqual({ decision: "ACK" });
    expect(calls).toHaveLength(1);
  });

  test("invalid then valid retries (executor called twice)", async () => {
    const calls: string[] = [];
    const exec: CommitExecutor = async () => {
      calls.push("x");
      return calls.length === 1 ? "garbage" : '{"decision":"NACK","reason":"late"}';
    };
    const res = await runValidator(v, ctx, exec);
    expect(res).toEqual({ decision: "NACK", reason: "late" });
    expect(calls).toHaveLength(2);
  });

  test("invalid twice yields invalid NACK", async () => {
    const exec: CommitExecutor = async () => "garbage";
    const res = await runValidator(v, ctx, exec);
    expect(res).toEqual({
      decision: "NACK",
      reason: "validator returned invalid response (no ACK decision)",
    });
  });
});

describe("parseBatchedOutput", () => {
  test("direct array", () => {
    const out = JSON.stringify([
      { id: "a", decision: "ACK" },
      { id: "b", decision: "NACK", reason: "r" },
    ]);
    const res = parseBatchedOutput(out, ["a", "b"]);
    expect(res).toEqual([
      { validator: "a", decision: "ACK" },
      { validator: "b", decision: "NACK", reason: "r" },
    ]);
  });

  test("fenced json", () => {
    const out = "```json\n" + JSON.stringify([{ id: "a", decision: "ACK" }]) + "\n```";
    const res = parseBatchedOutput(out, ["a"]);
    expect(res).toEqual([{ validator: "a", decision: "ACK" }]);
  });

  test("bracket extraction from prose", () => {
    const out = 'Here: ' + JSON.stringify([{ id: "a", decision: "NACK", reason: "x" }]) + ' ok?';
    const res = parseBatchedOutput(out, ["a"]);
    expect(res).toEqual([{ validator: "a", decision: "NACK", reason: "x" }]);
  });

  test("missing id NACKs", () => {
    const out = JSON.stringify([{ id: "a", decision: "ACK" }]);
    const res = parseBatchedOutput(out, ["a", "b"]);
    expect(res).toEqual([
      { validator: "a", decision: "ACK" },
      { validator: "b", decision: "NACK", reason: "validator missing or invalid in batched response" },
    ]);
  });

  test("validator key alias", () => {
    const out = JSON.stringify([{ validator: "a", decision: "ACK" }]);
    expect(parseBatchedOutput(out, ["a"])).toEqual([{ validator: "a", decision: "ACK" }]);
  });

  test("garbage NACKs all", () => {
    const res = parseBatchedOutput("nothing", ["a", "b"]);
    expect(res).toEqual([
      { validator: "a", decision: "NACK", reason: "batched validator returned unparseable response" },
      { validator: "b", decision: "NACK", reason: "batched validator returned unparseable response" },
    ]);
  });
});

describe("validateCommit", () => {
  const tier0V = makeValidator({ name: "no-dangerous-git", tier: 0 });
  const tier1V = makeValidator({ name: "t1", tier: 1 });
  const tier2V = makeValidator({ name: "t2", tier: 2 });

  test("routes mixed tiers and forwards tierModels to executor", async () => {
    const seen: Array<{ model?: unknown }> = [];
    const exec: CommitExecutor = async (_p, model) => {
      seen.push({ model });
      return JSON.stringify([
        { id: "t1", decision: "ACK" },
        { id: "t2", decision: "ACK" },
      ]);
    };
    const results = await validateCommit(
      [tier1V, tier0V, tier2V],
      { ...ctx, command: "git commit -m ok" },
      {
        executor: exec,
        tierModels: {
          tier1: { providerID: "p1", modelID: "m1" },
          tier2: { providerID: "p2", modelID: "m2" },
        },
      },
    );
    // tier0 first (sync), then tier1, then tier2
    expect(results.map((r) => r.validator)).toEqual(["no-dangerous-git", "t1", "t2"]);
    expect(seen).toHaveLength(2);
    expect(seen[0].model).toEqual({ providerID: "p1", modelID: "m1" });
    expect(seen[1].model).toEqual({ providerID: "p2", modelID: "m2" });
  });

  test("batching boundaries [3,3,1] for 7 validators at count 3", async () => {
    const names = Array.from({ length: 7 }, (_, i) => `v${i}`);
    const validators = names.map((n) => makeValidator({ name: n, tier: 2 }));
    const batchSizes: number[] = [];
    const exec: CommitExecutor = async (_p) => {
      // approximate the batch by counting names sent in the prompt
      batchSizes.push((_p.match(/<validator id=/g) ?? []).length);
      return JSON.stringify(names.map((n) => ({ id: n, decision: "ACK" })));
    };
    await validateCommit(validators, ctx, { executor: exec, batchCount: 3 });
    expect(batchSizes).toEqual([3, 3, 1]);
  });

  test("crash-batch yields 'validator crashed' NACKs appealable false", async () => {
    const validators = [
      makeValidator({ name: "a", tier: 2 }),
      makeValidator({ name: "b", tier: 2 }),
    ];
    const exec: CommitExecutor = async () => {
      throw new Error("boom");
    };
    const results = await validateCommit(validators, ctx, { executor: exec });
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.decision).toBe("NACK");
      expect(r.reason?.startsWith("validator crashed:")).toBe(true);
      expect(r.appealable).toBe(false);
    }
  });

  test("no executor skips tier1/2 (fail-open) and fires onLog skip", async () => {
    const logged: string[] = [];
    const results = await validateCommit([tier0V, tier1V, tier2V], { ...ctx, command: "git commit -m ok" }, {
      onLog: (e, n) => {
        if (e === "skip") logged.push(n);
      },
    });
    expect(results.map((r) => r.validator)).toEqual(["no-dangerous-git"]);
    expect(logged).toEqual(["t1", "t2"]);
  });
});

describe("formatBlockMessage", () => {
  test("reason lines plus appealable hint", () => {
    const msg = formatBlockMessage([
      { validator: "a", decision: "NACK", reason: "r1", appealable: true },
    ]);
    expect(msg).toContain("a: r1");
    expect(msg).toContain("To appeal, add [appeal: your justification] to your commit message.");
    expect(msg).not.toContain("This violation cannot be appealed.");
  });

  test("non-appealable hint present, appealable hint absent", () => {
    const msg = formatBlockMessage([
      { validator: "a", decision: "NACK", reason: "r1", appealable: false },
    ]);
    expect(msg).toContain("This violation cannot be appealed.");
    expect(msg).not.toContain("[appeal:");
  });

  test("no NACKs yields empty message", () => {
    expect(formatBlockMessage([{ validator: "a", decision: "ACK", appealable: true }])).toBe("");
  });
});

describe("readValidatorState", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bp-state-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("missing file returns defaults", () => {
    const s = readValidatorState(join(dir, "none.json"));
    expect(s.validateCommit.mode).toBe("strict");
    expect(s.validateCommit.batchCount).toBe(3);
    expect(s.models.tier1).toBeNull();
    expect(s.models.tier2).toBeNull();
    expect(s.overrides.validators).toEqual({});
  });

  test("partial JSON deep-merged", () => {
    const file = join(dir, "s.json");
    writeFileSync(file, JSON.stringify({ validateCommit: { mode: "warn" } }), "utf8");
    const s = readValidatorState(file);
    expect(s.validateCommit.mode).toBe("warn");
    expect(s.validateCommit.batchCount).toBe(3);
    expect(s.models.tier1).toBeNull();
  });

  test("invalid JSON returns defaults", () => {
    const file = join(dir, "bad.json");
    writeFileSync(file, "{not json", "utf8");
    const s = readValidatorState(file);
    expect(s).toEqual(DEFAULT_VALIDATOR_STATE);
  });
});

describe("getCommitContext (guarded integration)", () => {
  test("reads staged diff, files, and handles cd prefix", () => {
    try {
      execFileSync("git", ["--version"]);
    } catch {
      test.skip("git not available");
      return;
    }
    const repo = mkdtempSync(join(tmpdir(), "bp-git-"));
    const run = (cmd: string, cwd: string) =>
      execFileSync("git", cmd.split(" "), { cwd, encoding: "utf8" });
    run("init", repo);
    const file = join(repo, "hello.txt");
    writeFileSync(file, "one\ntwo\n", "utf8");
    run("add hello.txt", repo);
    run("config user.email t@t.t", repo);
    run("config user.name t", repo);

    const context = getCommitContext(repo, 'cd . && git commit -m "add hello"');
    expect(context.files).toEqual(["hello.txt"]);
    expect(context.diff).toContain("hello.txt");
    expect(context.diff).toContain("+one");
    expect(context.message).toBe("add hello");
    expect(context.cwd.endsWith(repo)).toBe(true);

    rmSync(repo, { recursive: true, force: true });
  });
});