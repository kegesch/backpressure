import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate, partitionSemgrepFindings, composeAdvisory, composeAdvisoryDelta, resolveRuleMode, type ToolCallDescription, type SemgrepFinding, type AdvisoryFinding, type SensorFinding } from "./core.ts";

const ROOT = "C:/proj";
const cfg = { protectedRoot: ROOT };

function pathCall(paths: string[], tool = "write"): ToolCallDescription {
  return { tool, paths, workdir: ROOT };
}

function bashCall(command?: string | number): ToolCallDescription {
  return { tool: "bash", paths: [], command: command as string, workdir: ROOT };
}

describe("tool-path rule", () => {
  test("direct absolute backslash-separated path blocks", () => {
    const v = evaluate(pathCall(["C:\\proj\\.backpressure\\x"]), cfg);
    expect(v.decision).toBe("block");
    expect(v.rule).toBe("tool-path");
    expect(v.matchedIntent).toBe("protected-path");
    expect(v.detail).toBe("c:/proj/.backpressure/x");
  });

  test("direct absolute forward-slash path blocks", () => {
    const v = evaluate(pathCall(["C:/proj/.backpressure/x"]), cfg);
    expect(v.decision).toBe("block");
    expect(v.rule).toBe("tool-path");
  });

  test("bare relative .backpressure path blocks", () => {
    const v = evaluate(pathCall([".backpressure\\x"]), cfg);
    expect(v.decision).toBe("block");
    expect(v.detail).toBe("c:/proj/.backpressure/x");
  });

  test("traversal resolving under protected root blocks", () => {
    const v = evaluate(pathCall(["sub\\..\\.backpressure\\x"]), cfg);
    expect(v.decision).toBe("block");
    expect(v.detail).toBe("c:/proj/.backpressure/x");
  });

  test("traversal escaping outside protected root allows", () => {
    const v = evaluate(pathCall(["sub\\..\\..\\.backpressure\\x"]), cfg);
    expect(v.decision).toBe("allow");
  });

  test("mixed separators block", () => {
    const v = evaluate(pathCall(["C:\\proj/.backpressure\\x"]), cfg);
    expect(v.decision).toBe("block");
  });

  test("case variant .BACKPRESSURE blocks", () => {
    const v = evaluate(pathCall(["C:\\proj\\.BACKPRESSURE\\x"]), cfg);
    expect(v.decision).toBe("block");
  });

  test("drive-letter case variant blocks", () => {
    const v = evaluate(pathCall(["c:\\proj\\.backpressure\\x"]), cfg);
    expect(v.decision).toBe("block");
  });

  test("edit tool with protected path blocks", () => {
    const v = evaluate(pathCall(["C:/proj/.backpressure/x"], "edit"), cfg);
    expect(v.decision).toBe("block");
    expect(v.rule).toBe("tool-path");
  });

  test("protected path in second paths slot blocks", () => {
    const v = evaluate(pathCall(["C:/proj/ok.txt", "C:/proj/.backpressure/x"]), cfg);
    expect(v.decision).toBe("block");
    expect(v.detail).toBe("c:/proj/.backpressure/x");
  });

  test("path under a different root allows", () => {
    const v = evaluate(pathCall(["C:/elsewhere/.backpressure/x"]), cfg);
    expect(v.decision).toBe("allow");
  });

  test("near-miss .backpressure-extra allows", () => {
    const v = evaluate(pathCall(["C:/proj/.backpressure-extra/x"]), cfg);
    expect(v.decision).toBe("allow");
  });

  test("relative non-protected path allows", () => {
    const v = evaluate(pathCall(["iter9-m5-ok.txt"]), cfg);
    expect(v.decision).toBe("allow");
  });

  test("non-write tools with protected path allow", () => {
    expect(evaluate(pathCall(["C:/proj/.backpressure/x"], "read"), cfg).decision).toBe("allow");
    expect(evaluate(pathCall(["C:/proj/.backpressure/x"], "bash"), cfg).decision).toBe("allow");
  });

  test("empty paths allows", () => {
    const v = evaluate(pathCall([]), cfg);
    expect(v.decision).toBe("allow");
  });
});

describe("shell-write rule", () => {
  test("Set-Content token blocks", () => {
    const v = evaluate(bashCall('Set-Content -LiteralPath "C:/proj/.backpressure/m3a.txt" -Value "a"'), cfg);
    expect(v.decision).toBe("block");
    expect(v.rule).toBe("shell-write");
    expect(v.matchedIntent).toBe("set-content");
  });

  test("Copy-Item token blocks", () => {
    const v = evaluate(bashCall("Copy-Item C:/proj/.backpressure/x C:/proj/y"), cfg);
    expect(v.matchedIntent).toBe("copy-item");
  });

  test("aliases block", () => {
    for (const [cmd, intent] of [
      ["cpi C:/proj/.backpressure/x C:/proj/y", "cpi"],
      ["ni C:/proj/.backpressure/x", "ni"],
      ["md C:/proj/.backpressure", "md"],
      ["mkdir C:/proj/.backpressure", "mkdir"],
      ["cp C:/proj/.backpressure/x C:/proj/y", "cp"],
      ["mv C:/proj/.backpressure/x C:/proj/y", "mv"],
      ["rm C:/proj/.backpressure/x", "rm"],
      ["touch C:/proj/.backpressure/x", "touch"],
    ] as const) {
      const v = evaluate(bashCall(cmd), cfg);
      expect(v.decision).toBe("block");
      expect(v.matchedIntent).toBe(intent);
    }
  });

  test("uppercase SET-CONTENT blocks", () => {
    const v = evaluate(bashCall("SET-CONTENT C:/proj/.backpressure/x x"), cfg);
    expect(v.matchedIntent).toBe("set-content");
  });

  test("sed -i blocks", () => {
    const v = evaluate(bashCall("sed -i 's/a/b/' C:/proj/.backpressure/x"), cfg);
    expect(v.matchedIntent).toBe("sed-in-place");
  });

  test("sed -ri blocks", () => {
    const v = evaluate(bashCall("sed -ri 's/a/b/' C:/proj/.backpressure/x"), cfg);
    expect(v.matchedIntent).toBe("sed-in-place");
  });

  test("sed --in-place blocks", () => {
    const v = evaluate(bashCall("sed --in-place 's/a/b/' C:/proj/.backpressure/x"), cfg);
    expect(v.matchedIntent).toBe("sed-in-place");
  });

  test("bare > redirect blocks", () => {
    const v = evaluate(bashCall("echo b > C:/proj/.backpressure/m3b.txt"), cfg);
    expect(v.matchedIntent).toBe("redirect");
  });

  test("bare >> redirect blocks", () => {
    const v = evaluate(bashCall("echo b >> C:/proj/.backpressure/m3b.txt"), cfg);
    expect(v.matchedIntent).toBe("redirect");
  });

  test("redirect with quoted protected path blocks", () => {
    const v = evaluate(bashCall('echo b > "C:/proj/.backpressure/m3b.txt"'), cfg);
    expect(v.matchedIntent).toBe("redirect");
  });

  test("write token in quotes stripped but redirect still matches", () => {
    const v = evaluate(bashCall('echo "set-content" > C:/proj/.backpressure/x'), cfg);
    expect(v.decision).toBe("block");
    expect(v.matchedIntent).toBe("redirect");
  });

  test("Get-Content allows", () => {
    const v = evaluate(bashCall("Get-Content C:/proj/.backpressure/hook-log.jsonl"), cfg);
    expect(v.decision).toBe("allow");
  });

  test("read-only commands on protected path allow", () => {
    for (const cmd of [
      "Select-String x C:/proj/.backpressure/hook-log.jsonl",
      "cat C:/proj/.backpressure/log",
      "grep x C:/proj/.backpressure/log",
      "ls C:/proj/.backpressure",
      "dir C:/proj/.backpressure",
      "Test-Path C:/proj/.backpressure",
    ]) {
      expect(evaluate(bashCall(cmd), cfg).decision).toBe("allow");
    }
  });

  test("sed without -i allows", () => {
    const v = evaluate(bashCall("sed 's/a/b/' C:/proj/.backpressure/x"), cfg);
    expect(v.decision).toBe("allow");
  });

  test("2>&1 exclusion allows", () => {
    const v = evaluate(bashCall("Get-Content C:/proj/.backpressure/log 2>&1"), cfg);
    expect(v.decision).toBe("allow");
  });

  test("-> exclusion allows", () => {
    const v = evaluate(bashCall("Test-Path C:/proj/.backpressure -> out"), cfg);
    expect(v.decision).toBe("allow");
  });

  test("write token without .backpressure allows", () => {
    const v = evaluate(bashCall("Set-Content C:/proj/foo.txt x"), cfg);
    expect(v.decision).toBe("allow");
  });

  test("redirect without .backpressure allows", () => {
    const v = evaluate(bashCall("echo b > C:/proj/foo.txt"), cfg);
    expect(v.decision).toBe("allow");
  });

  test("bash without command allows", () => {
    const v = evaluate(bashCall(undefined), cfg);
    expect(v.decision).toBe("allow");
  });

  test("bash with non-string command allows", () => {
    const v = evaluate(bashCall(123), cfg);
    expect(v.decision).toBe("allow");
  });

  test("powershell Get-Content of protected path allows", () => {
    const v = evaluate(bashCall('powershell -Command "Get-Content .backpressure\\log"'), cfg);
    expect(v.decision).toBe("allow");
  });
});

describe("pinned over-block class (accepted iter-4 finding)", () => {
  test("Get-Content .backpressure/log > out.txt blocks", () => {
    const v = evaluate(bashCall("Get-Content C:/proj/.backpressure/log > out.txt"), cfg);
    expect(v.decision).toBe("block");
    expect(v.matchedIntent).toBe("redirect");
  });

  test(".backpressure-notmine substring blocks", () => {
    const v = evaluate(bashCall("Set-Content C:/proj/.backpressure-notmine/x x"), cfg);
    expect(v.decision).toBe("block");
    expect(v.matchedIntent).toBe("set-content");
  });
});

describe("verdict contract shape", () => {
  test("allow is exactly decision+verdictVersion", () => {
    const v = evaluate(pathCall(["C:/proj/ok.txt"]), cfg);
    expect(v).toEqual({ decision: "allow", verdictVersion: 2 });
    expect(v.rule).toBeUndefined();
    expect(v.message).toBeUndefined();
    expect(v.matchedIntent).toBeUndefined();
    expect(v.reason).toBeUndefined();
    expect(v.detail).toBeUndefined();
    expect(v.appealable).toBeUndefined();
  });

  test("block carries all fields", () => {
    const v = evaluate(pathCall(["C:/proj/.backpressure/x"]), cfg);
    expect(v.decision).toBe("block");
    expect(v.rule).toBe("tool-path");
    expect(v.matchedIntent).toBe("protected-path");
    expect(v.reason).toBe("protected path .backpressure/**");
    expect(v.detail).toBe("c:/proj/.backpressure/x");
    expect(v.appealable).toBe(true);
    expect(v.verdictVersion).toBe(2);
    expect(v.message).toBeTruthy();
  });

  test("tool-path golden message bytes", () => {
    const v = evaluate(pathCall(["C:/proj/.backpressure/x"]), cfg);
    const expected = [
      "BACKPRESSURE VERDICT: BLOCK (rule protected-path: write/edit to '.backpressure/**').",
      "WHY: '.backpressure/' holds the backpressure engine's own enforcement and audit state (hook log, verdicts, future ratchet store). Writes by agents could tamper with the referee that judges their work, so this path is protected.",
      "INSTEAD: Write scratch and validation files to the workdir (e.g. 'iter5-validation/'). This block is not a challenge to route around: writing a file elsewhere and then copying or moving it into '.backpressure/' is a violation, not a workaround.",
      "APPEAL: If you believe this write is genuinely needed, state an appeal with reasons in your final reply. A human reviews appeals.",
    ].join("\n");
    expect(v.message).toBe(expected);
    expect(v.message).toContain("WHY:");
    expect(v.message).toContain("INSTEAD:");
    expect(v.message).toContain("APPEAL:");
    expect(v.message).not.toContain("This decision is final");
  });

  test("shell-write golden message bytes", () => {
    const v = evaluate(bashCall("Set-Content C:/proj/.backpressure/x x"), cfg);
    const expected = [
      "BACKPRESSURE VERDICT: BLOCK (rule shell-write: shell command writes into '.backpressure/**').",
      "WHY: '.backpressure/' holds the backpressure engine's own enforcement and audit state (hook log, verdicts, future ratchet store). Writes by agents could tamper with the referee that judges their work, so this path is protected.",
      "INSTEAD: Write scratch and validation files to the workdir (e.g. 'iter5-validation/'). This block is not a challenge to route around: writing a file elsewhere and then copying or moving it into '.backpressure/' is a violation, not a workaround.",
      "APPEAL: If you believe this write is genuinely needed, state an appeal with reasons in your final reply. A human reviews appeals.",
    ].join("\n");
    expect(v.message).toBe(expected);
    expect(v.message).toContain("WHY:");
    expect(v.message).toContain("INSTEAD:");
    expect(v.message).toContain("APPEAL:");
    expect(v.message).not.toContain("This decision is final");
    expect(v.detail).toBe("Set-Content C:/proj/.backpressure/x x");
    expect(v.reason).toBe("shell write-intent targeting .backpressure/**");
  });

  test("evaluate is deterministic", () => {
    const a = evaluate(bashCall("Set-Content C:/proj/.backpressure/x x"), cfg);
    const b = evaluate(bashCall("Set-Content C:/proj/.backpressure/x x"), cfg);
    expect(a).toEqual(b);
  });
});

const scfg = { protectedRoot: ROOT, qualityRoots: ["C:/proj/engine"] };

function sCall(paths: string[], findings: SemgrepFinding[], tool = "write"): ToolCallDescription {
  return { tool, paths, workdir: ROOT, content: "x", semgrepFindings: findings };
}

function errFinding(over: Partial<SemgrepFinding> = {}): SemgrepFinding {
  return {
    checkId: "no-eval",
    severity: "ERROR",
    message: "eval() is forbidden",
    startLine: 3,
    ...over,
  };
}

describe("semgrep rule", () => {
  test("ERROR finding blocks with full contract", () => {
    const v = evaluate(sCall(["C:/proj/engine/w1.ts"], [errFinding()]), scfg);
    expect(v).toMatchObject({
      decision: "block",
      rule: "semgrep",
      matchedIntent: "no-eval",
      detail: "c:/proj/engine/w1.ts",
      appealable: true,
      verdictVersion: 2,
    });
    expect(v.reason).toBe("eval() is forbidden (line 3)");
  });

  test("WARNING finding blocks", () => {
    const v = evaluate(sCall(["C:/proj/engine/w1.ts"], [errFinding({ severity: "WARNING" })]), scfg);
    expect(v.decision).toBe("block");
    expect(v.rule).toBe("semgrep");
  });

  test("INFO finding allows", () => {
    const v = evaluate(sCall(["C:/proj/engine/w1.ts"], [errFinding({ severity: "INFO" })]), scfg);
    expect(v.decision).toBe("allow");
  });

  test("empty findings allows", () => {
    const v = evaluate(sCall(["C:/proj/engine/w1.ts"], []), scfg);
    expect(v.decision).toBe("allow");
  });

  test("undefined findings allows", () => {
    const call: ToolCallDescription = { tool: "write", paths: ["C:/proj/engine/w1.ts"], workdir: ROOT, content: "x" };
    expect(evaluate(call, scfg).decision).toBe("allow");
  });

  test("severity rank ERROR before WARNING", () => {
    const v = evaluate(
      sCall(["C:/proj/engine/w1.ts"], [
        errFinding({ checkId: "b-warn", severity: "WARNING", startLine: 1 }),
        errFinding({ checkId: "a-err", severity: "ERROR", startLine: 9 }),
      ]),
      scfg
    );
    expect(v.matchedIntent).toBe("a-err");
  });

  test("line order asc within same severity", () => {
    const v = evaluate(
      sCall(["C:/proj/engine/w1.ts"], [
        errFinding({ checkId: "a", startLine: 9 }),
        errFinding({ checkId: "b", startLine: 2 }),
      ]),
      scfg
    );
    expect(v.matchedIntent).toBe("b");
    expect(v.reason).toContain("(line 2)");
  });

  test("checkId lexical tie-break", () => {
    const v = evaluate(
      sCall(["C:/proj/engine/w1.ts"], [
        errFinding({ checkId: "zz", startLine: 1 }),
        errFinding({ checkId: "aa", startLine: 1 }),
      ]),
      scfg
    );
    expect(v.matchedIntent).toBe("aa");
  });

  test("instead override appears in INSTEAD line", () => {
    const v = evaluate(
      sCall(["C:/proj/engine/w1.ts"], [errFinding({ instead: "Write explicit logic." })]),
      scfg
    );
    expect(v.message).toContain("INSTEAD: Write explicit logic.");
  });

  test("default INSTEAD when no override", () => {
    const v = evaluate(sCall(["C:/proj/engine/w1.ts"], [errFinding()]), scfg);
    expect(v.message).toContain("Fix the pattern violation identified by the rule");
  });

  test("appealable false renders NOTE line and false field", () => {
    const v = evaluate(
      sCall(["C:/proj/engine/w1.ts"], [errFinding({ appealable: false })]),
      scfg
    );
    expect(v.appealable).toBe(false);
    expect(v.message).toContain("NOTE: This block is not appealable.");
    expect(v.message).not.toContain("APPEAL:");
  });

  test("default appealable true", () => {
    const v = evaluate(sCall(["C:/proj/engine/w1.ts"], [errFinding()]), scfg);
    expect(v.appealable).toBe(true);
    expect(v.message).toContain("APPEAL:");
  });

  test("why override renders in WHY line", () => {
    const v = evaluate(
      sCall(["C:/proj/engine/w1.ts"], [errFinding({ why: "Custom why text." })]),
      scfg
    );
    expect(v.message).toContain("WHY: Custom why text.");
  });

  test("default WHY embeds rule id severity and message", () => {
    const v = evaluate(sCall(["C:/proj/engine/w1.ts"], [errFinding()]), scfg);
    expect(v.message).toContain("WHY: Semgrep rule 'no-eval' (severity ERROR) matched: eval() is forbidden");
  });

  test("missing message fallback", () => {
    const v = evaluate(sCall(["C:/proj/engine/w1.ts"], [errFinding({ message: undefined })]), scfg);
    expect(v.reason).toBe("(line 3)");
    expect(v.message).toContain("matched a pattern violation");
  });

  test("missing startLine graceful", () => {
    const v = evaluate(sCall(["C:/proj/engine/w1.ts"], [errFinding({ startLine: undefined })]), scfg);
    expect(v.reason).toBe("eval() is forbidden");
  });

  test("checkId over 100 chars sliced", () => {
    const long = "x".repeat(120);
    const v = evaluate(sCall(["C:/proj/engine/w1.ts"], [errFinding({ checkId: long })]), scfg);
    expect(v.matchedIntent).toBe("x".repeat(100));
  });

  test("tool-path precedes semgrep findings", () => {
    const v = evaluate(sCall(["C:/proj/.backpressure/w1.ts"], [errFinding()]), scfg);
    expect(v.rule).toBe("tool-path");
    expect(v.matchedIntent).toBe("protected-path");
  });

  test("out-of-scope findings allow", () => {
    const v = evaluate(sCall(["C:/proj/other/w1.ts"], [errFinding()]), scfg);
    expect(v.decision).toBe("allow");
  });

  test("non-write/edit with findings allow", () => {
    const v = evaluate(sCall(["C:/proj/engine/w1.ts"], [errFinding()], "read"), scfg);
    expect(v.decision).toBe("allow");
  });

  test("message line 1 exact and no finality text", () => {
    const v = evaluate(sCall(["C:/proj/engine/w1.ts"], [errFinding()]), scfg);
    expect(v.message!.split("\n")[0]).toBe("BACKPRESSURE VERDICT: BLOCK (rule semgrep: 'no-eval').");
    expect(v.message).not.toContain("This decision is final");
  });

  test("semgrep evaluate deterministic", () => {
    const a = evaluate(sCall(["C:/proj/engine/w1.ts"], [errFinding()]), scfg);
    const b = evaluate(sCall(["C:/proj/engine/w1.ts"], [errFinding()]), scfg);
    expect(a).toEqual(b);
  });

  test("INFO-only allow shape exact", () => {
    const v = evaluate(sCall(["C:/proj/engine/w1.ts"], [errFinding({ severity: "INFO" })]), scfg);
    expect(v).toEqual({ decision: "allow", verdictVersion: 2 });
  });
});

describe("engine purity", () => {
  test("core.ts source imports no node:fs or child_process", () => {
    const src = readFileSync(join(import.meta.dir, "core.ts"), "utf8");
    expect(src).not.toMatch(/from\s+["']node:fs["']/);
    expect(src).not.toMatch(/from\s+["']node:child_process["']/);
    expect(readdirSync(import.meta.dir).filter((f) => f.endsWith(".ts")).length).toBeGreaterThan(0);
  });
});

function snCall(paths: string[], findings: SensorFinding[], tool = "write"): ToolCallDescription {
  return { tool, paths, workdir: ROOT, content: "x", sensorFindings: findings };
}

function snFinding(over: Partial<SensorFinding> = {}): SensorFinding {
  return {
    checkId: "no-unused-vars",
    severity: "ERROR",
    message: "'x' is assigned a value but never used",
    startLine: 1,
    status: "adopted",
    sensorId: "eslint",
    ...over,
  };
}

describe("sensor rule", () => {
  test("ERROR violation blocks with full contract and 4-line message GOLDEN", () => {
    const v = evaluate(snCall(["C:/proj/engine/w1.ts"], [snFinding()]), scfg);
    expect(v.decision).toBe("block");
    expect(v.rule).toBe("sensor");
    expect(v.matchedIntent).toBe("no-unused-vars");
    expect(v.reason).toBe("'x' is assigned a value but never used (line 1)");
    expect(v.detail).toBe("c:/proj/engine/w1.ts");
    expect(v.appealable).toBe(true);
    expect(v.modeConflict).toBeUndefined();
    expect(v.verdictVersion).toBe(2);
    const golden = [
      "BACKPRESSURE VERDICT: BLOCK (rule sensor: 'no-unused-vars').",
      "WHY: Sensor 'eslint' rule 'no-unused-vars' (severity ERROR) matched: 'x' is assigned a value but never used",
      "INSTEAD: Fix the finding reported by the sensor, or ask the user to adjust the sensor in '.backpressure/sensors/' if it is wrong.",
      "APPEAL: If you believe this write is genuinely needed, state an appeal with reasons in your final reply. A human reviews appeals.",
    ].join("\n");
    expect(v.message).toBe(golden);
  });

  test("WARNING violation blocks", () => {
    const v = evaluate(snCall(["C:/proj/engine/w1.ts"], [snFinding({ severity: "WARNING" })]), scfg);
    expect(v.decision).toBe("block");
    expect(v.rule).toBe("sensor");
  });

  test("INFO violation ignored (allow exact shape)", () => {
    const v = evaluate(snCall(["C:/proj/engine/w1.ts"], [snFinding({ severity: "INFO" })]), scfg);
    expect(v).toEqual({ decision: "allow", verdictVersion: 2 });
  });

  test("status draft partitions to advise: allow verdict, no block", () => {
    const findings = [snFinding({ status: "draft" })];
    const v = evaluate(snCall(["C:/proj/engine/w1.ts"], findings), scfg);
    expect(v).toEqual({ decision: "allow", verdictVersion: 2 });
    const p = partitionSemgrepFindings(findings);
    expect(p.block).toHaveLength(0);
    expect(p.advise).toHaveLength(1);
    expect(p.advise[0].checkId).toBe("no-unused-vars");
  });

  test("adopted + mode advise blocks WITH modeConflict", () => {
    const v = evaluate(
      snCall(["C:/proj/engine/w1.ts"], [snFinding({ mode: "advise" })]),
      scfg
    );
    expect(v.decision).toBe("block");
    expect(v.rule).toBe("sensor");
    expect(v.modeConflict).toBe(true);
  });

  test("typo status fails closed to block with conflict", () => {
    const v = evaluate(snCall(["C:/proj/engine/w1.ts"], [snFinding({ status: "Draftt" })]), scfg);
    expect(v.decision).toBe("block");
    expect(v.modeConflict).toBe(true);
  });

  test("plain adopted block has NO modeConflict key", () => {
    const v = evaluate(snCall(["C:/proj/engine/w1.ts"], [snFinding()]), scfg);
    expect(v.decision).toBe("block");
    expect("modeConflict" in v).toBe(false);
  });

  test("why and instead overrides replace WHY and INSTEAD lines", () => {
    const v = evaluate(
      snCall(
        ["C:/proj/engine/w1.ts"],
        [snFinding({ why: "Custom sensor why.", instead: "Custom sensor instead." })]
      ),
      scfg
    );
    expect(v.message).toContain("WHY: Custom sensor why.");
    expect(v.message).toContain("INSTEAD: Custom sensor instead.");
    expect(v.message).not.toContain("'x' is assigned a value but never used");
  });

  test("appealable false renders NOTE line and false field", () => {
    const v = evaluate(snCall(["C:/proj/engine/w1.ts"], [snFinding({ appealable: false })]), scfg);
    expect(v.appealable).toBe(false);
    expect(v.message).toContain("NOTE: This block is not appealable.");
    expect(v.message).not.toContain("APPEAL:");
  });

  test("multi-violation pick is deterministic (severity rank, line asc, checkId)", () => {
    const findings = [
      snFinding({
        checkId: "z-rule",
        message: "'z' is assigned a value but never used",
        startLine: 9,
      }),
      snFinding({
        checkId: "b-rule",
        message: "'b' is assigned a value but never used",
        startLine: 2,
        severity: "WARNING",
      }),
      snFinding({
        checkId: "a-rule",
        message: "'a' is assigned a value but never used",
        startLine: 2,
      }),
    ];
    const a = evaluate(snCall(["C:/proj/engine/w1.ts"], findings), scfg);
    const b = evaluate(snCall(["C:/proj/engine/w1.ts"], [...findings].reverse()), scfg);
    expect(a).toEqual(b);
    expect(a.reason).toBe("'a' is assigned a value but never used (line 2)");
  });

  test("semgrep block precedes sensor block (first-match-wins)", () => {
    const call: ToolCallDescription = {
      tool: "write",
      paths: ["C:/proj/engine/w1.ts"],
      workdir: ROOT,
      content: "x",
      semgrepFindings: [errFinding({ checkId: "no-eval" })],
      sensorFindings: [snFinding()],
    };
    const v = evaluate(call, scfg);
    expect(v.decision).toBe("block");
    expect(v.rule).toBe("semgrep");
    expect(v.matchedIntent).toBe("no-eval");
  });

  test("sensor block with semgrep-advise-only fires sensor, no merged verdict", () => {
    const call: ToolCallDescription = {
      tool: "write",
      paths: ["C:/proj/engine/w1.ts"],
      workdir: ROOT,
      content: "x",
      semgrepFindings: [errFinding({ mode: "advise" })],
      sensorFindings: [snFinding()],
    };
    const v = evaluate(call, scfg);
    expect(v.decision).toBe("block");
    expect(v.rule).toBe("sensor");
    expect(v.matchedIntent).toBe("no-unused-vars");
  });

  test("no sensor findings allows exactly", () => {
    const v = evaluate(snCall(["C:/proj/engine/w1.ts"], []), scfg);
    expect(v).toEqual({ decision: "allow", verdictVersion: 2 });
  });

  test("tool-path precedes sensor on protected paths", () => {
    const v = evaluate(snCall(["C:/proj/.backpressure/w1.ts"], [snFinding()]), scfg);
    expect(v.decision).toBe("block");
    expect(v.rule).toBe("tool-path");
    expect(v.matchedIntent).toBe("protected-path");
  });
});

describe("enforcement mode (advise vs block)", () => {
  test("advise-mode ERROR finding allows exact shape", () => {
    const v = evaluate(sCall(["C:/proj/engine/w1.ts"], [errFinding({ mode: "advise" })]), scfg);
    expect(v).toEqual({ decision: "allow", verdictVersion: 2 });
  });

  test("mixed advise + default ERROR blocks byte-identical to default-only", () => {
    const mixed = evaluate(
      sCall(
        ["C:/proj/engine/w1.ts"],
        [errFinding({ checkId: "adv-rule", mode: "advise", startLine: 1 }), errFinding()]
      ),
      scfg
    );
    const only = evaluate(sCall(["C:/proj/engine/w1.ts"], [errFinding()]), scfg);
    expect(mixed.decision).toBe("block");
    expect(mixed.matchedIntent).toBe("no-eval");
    expect(mixed.message).toBe(only.message);
  });

  test("all-advise findings allow", () => {
    const v = evaluate(
      sCall(
        ["C:/proj/engine/w1.ts"],
        [errFinding({ checkId: "a", mode: "advise" }), errFinding({ checkId: "b", mode: "advise" })]
      ),
      scfg
    );
    expect(v.decision).toBe("allow");
  });

  test("explicit block-mode ERROR blocks", () => {
    const v = evaluate(sCall(["C:/proj/engine/w1.ts"], [errFinding({ mode: "block" })]), scfg);
    expect(v.decision).toBe("block");
    expect(v.rule).toBe("semgrep");
    expect(v.matchedIntent).toBe("no-eval");
  });

  test("typo mode 'advis' fails closed to block", () => {
    const v = evaluate(sCall(["C:/proj/engine/w1.ts"], [errFinding({ mode: "advis" as SemgrepFinding["mode"] })]), scfg);
    expect(v.decision).toBe("block");
    expect(v.matchedIntent).toBe("no-eval");
  });

  test("partition matrix severity x mode", () => {
    const f = (over: Partial<SemgrepFinding>): SemgrepFinding => errFinding(over);
    const p = partitionSemgrepFindings([
      f({ checkId: "err-advise", severity: "ERROR", mode: "advise" }),
      f({ checkId: "err-block", severity: "ERROR" }),
      f({ checkId: "warn-advise", severity: "WARNING", mode: "advise" }),
      f({ checkId: "warn-explicit", severity: "WARNING", mode: "block" }),
      f({ checkId: "info-advise", severity: "INFO", mode: "advise" }),
      f({ checkId: "info-plain", severity: "INFO" }),
    ]);
    expect(p.block.map((x) => x.checkId)).toEqual(["err-block", "warn-explicit"]);
    expect(p.advise.map((x) => x.checkId)).toEqual(["err-advise", "warn-advise"]);
    expect(p.ignored.map((x) => x.checkId)).toEqual(["info-advise", "info-plain"]);
  });

  test("WARNING advise allows", () => {
    const v = evaluate(
      sCall(["C:/proj/engine/w1.ts"], [errFinding({ severity: "WARNING", mode: "advise" })]),
      scfg
    );
    expect(v.decision).toBe("allow");
  });
});

describe("composeAdvisory", () => {
  const base = (over: Partial<AdvisoryFinding> = {}): AdvisoryFinding => ({
    checkId: "engine-no-console-log",
    severity: "ERROR",
    message: "console.log left in engine code — debug output should not ship",
    startLine: 1,
    mode: "advise",
    path: "c:/users/mail/workspace/opencode-backpressure/engine/iter12-dedupe.ts",
    ...over,
  });

  test("single-finding GOLDEN exact bytes", () => {
    const golden = [
      "BACKPRESSURE ADVISORY: advise-mode rule(s) matched content written this session (1 finding(s)). Nothing was blocked; the writes have already landed. This advisory is delivered once per session.",
      "WHY: Rule 'engine-no-console-log' (severity ERROR) matched: console.log left in engine code — debug output should not ship (c:/users/mail/workspace/opencode-backpressure/engine/iter12-dedupe.ts, line 1).",
      "INSTEAD: Remove the console.log call or return a diagnostic value.",
      "APPEAL: If you believe a finding is wrong, state an appeal with reasons in your reply. A human reviews appeals.",
    ].join("\n");
    expect(
      composeAdvisory([
        base({ instead: "Remove the console.log call or return a diagnostic value." }),
      ])
    ).toBe(golden);
  });

  test("multi-finding ordering severity rank then line asc then checkId", () => {
    const a = base({ checkId: "z-rule", startLine: 9 });
    const b = base({ checkId: "a-rule", startLine: 2 });
    const c = base({ checkId: "m-warn", severity: "WARNING", startLine: 1 });
    const text = composeAdvisory([a, b, c]);
    const idxA = text.indexOf("Rule 'z-rule'");
    const idxB = text.indexOf("Rule 'a-rule'");
    const idxC = text.indexOf("Rule 'm-warn'");
    expect(idxC).toBeGreaterThan(-1);
    expect(idxB).toBeLessThan(idxA);
    expect(idxC).toBeGreaterThan(idxA);
  });

  test("cap at 10 with suppression line", () => {
    const many: AdvisoryFinding[] = [];
    for (let i = 0; i < 12; i++) {
      many.push(base({ checkId: `rule-${i}`, startLine: i }));
    }
    const text = composeAdvisory(many);
    const whyCount = (text.match(/WHY: Rule '/g) ?? []).length;
    expect(whyCount).toBe(10);
    expect(text).toContain("and 2 further finding(s) suppressed");
  });

  test("first non-empty instead override wins", () => {
    const text = composeAdvisory([
      base({ instead: "" }),
      base({ checkId: "second", startLine: 2, instead: "Second remedy." }),
    ]);
    expect(text).toContain("INSTEAD: Second remedy.");
  });

  test("default INSTEAD when no override", () => {
    const text = composeAdvisory([base({ instead: undefined })]);
    expect(text).toContain("INSTEAD: Fix the flagged patterns before continuing, or ask the user to adjust the rules in '.backpressure/rules/' if a rule is wrong.");
  });

  test("APPEAL line default", () => {
    const text = composeAdvisory([base()]);
    expect(text).toContain("APPEAL: If you believe a finding is wrong, state an appeal with reasons in your reply. A human reviews appeals.");
    expect(text).not.toContain("NOTE: Some findings are not appealable.");
  });

  test("NOTE replaces APPEAL when any finding is not appealable", () => {
    const text = composeAdvisory([base(), base({ checkId: "other", startLine: 5, appealable: false })]);
    expect(text).toContain("NOTE: Some findings are not appealable. Contact a human maintainer if you believe such a rule is wrong.");
    expect(text).not.toContain("APPEAL:");
  });

  test("missing message graceful fallback", () => {
    const text = composeAdvisory([base({ message: undefined })]);
    expect(text).toContain("matched: matched a pattern violation in the candidate content.");
  });

  test("missing startLine omits line segment", () => {
    const text = composeAdvisory([base({ startLine: undefined })]);
    expect(text).toContain("(c:/users/mail/workspace/opencode-backpressure/engine/iter12-dedupe.ts).");
    expect(text).not.toContain(", line");
  });
});

describe("resolveRuleMode (rule lifecycle status)", () => {
  test("status absent keeps mode semantics without conflict", () => {
    expect(resolveRuleMode(undefined, undefined)).toEqual({ mode: "block", conflict: false });
    expect(resolveRuleMode(undefined, "advise")).toEqual({ mode: "advise", conflict: false });
    expect(resolveRuleMode(undefined, "block")).toEqual({ mode: "block", conflict: false });
  });

  test("draft resolves advise (absent or advise) without conflict, case-insensitive", () => {
    expect(resolveRuleMode("draft", undefined)).toEqual({ mode: "advise", conflict: false });
    expect(resolveRuleMode("draft", "advise")).toEqual({ mode: "advise", conflict: false });
    expect(resolveRuleMode("Draft", undefined)).toEqual({ mode: "advise", conflict: false });
    expect(resolveRuleMode("DRAFT", "advise")).toEqual({ mode: "advise", conflict: false });
  });

  test("draft + block fails closed to block WITH conflict", () => {
    expect(resolveRuleMode("draft", "block")).toEqual({ mode: "block", conflict: true });
    expect(resolveRuleMode("Draft", "block")).toEqual({ mode: "block", conflict: true });
  });

  test("adopted resolves block (absent or block) without conflict, case-insensitive", () => {
    expect(resolveRuleMode("adopted", undefined)).toEqual({ mode: "block", conflict: false });
    expect(resolveRuleMode("adopted", "block")).toEqual({ mode: "block", conflict: false });
    expect(resolveRuleMode("ADOPTED", "block")).toEqual({ mode: "block", conflict: false });
    expect(resolveRuleMode("Adopted", undefined)).toEqual({ mode: "block", conflict: false });
  });

  test("adopted + advise fails closed to block WITH conflict", () => {
    expect(resolveRuleMode("adopted", "advise")).toEqual({ mode: "block", conflict: true });
    expect(resolveRuleMode("ADOPTED", "advise")).toEqual({ mode: "block", conflict: true });
  });

  test("typo/unknown status fails closed to block WITH conflict regardless of mode", () => {
    expect(resolveRuleMode("Draftt", "advise")).toEqual({ mode: "block", conflict: true });
    expect(resolveRuleMode("Draftt", "block")).toEqual({ mode: "block", conflict: true });
    expect(resolveRuleMode("mature", undefined)).toEqual({ mode: "block", conflict: true });
    expect(resolveRuleMode("", "advise")).toEqual({ mode: "block", conflict: true });
  });
});

describe("partition and evaluate with rule status", () => {
  test("status-bearing partition matrix", () => {
    const p = partitionSemgrepFindings([
      errFinding({ checkId: "draft-plain", status: "draft" }),
      errFinding({ checkId: "draft-advise", status: "draft", mode: "advise" }),
      errFinding({ checkId: "adopted-plain", status: "adopted" }),
      errFinding({ checkId: "adopted-block", status: "adopted", mode: "block" }),
      errFinding({ checkId: "conflict-draft-block", status: "draft", mode: "block" }),
      errFinding({ checkId: "conflict-adopted-advise", status: "adopted", mode: "advise" }),
      errFinding({ checkId: "typo-status", status: "Draftt" }),
      errFinding({ checkId: "info-adopted", severity: "INFO", status: "adopted" }),
    ]);
    expect(p.advise.map((x) => x.checkId)).toEqual(["draft-plain", "draft-advise"]);
    expect(p.block.map((x) => x.checkId)).toEqual([
      "adopted-plain",
      "adopted-block",
      "conflict-draft-block",
      "conflict-adopted-advise",
      "typo-status",
    ]);
    expect(p.ignored.map((x) => x.checkId)).toEqual(["info-adopted"]);
  });

  test("status-less routing provably identical to legacy mode-only routing", () => {
    for (const mode of [undefined, "advise", "block"] as const) {
      const legacy = mode === "advise" ? "advise" : "block";
      expect(resolveRuleMode(undefined, mode).mode).toBe(legacy);
    }
  });

  test("conflicted block (draft+block) sets modeConflict true", () => {
    const v = evaluate(sCall(["C:/proj/engine/w1.ts"], [errFinding({ status: "draft", mode: "block" })]), scfg);
    expect(v.decision).toBe("block");
    expect(v.rule).toBe("semgrep");
    expect(v.modeConflict).toBe(true);
    expect(v.verdictVersion).toBe(2);
  });

  test("conflicted block (adopted+advise) sets modeConflict true", () => {
    const v = evaluate(sCall(["C:/proj/engine/w1.ts"], [errFinding({ status: "adopted", mode: "advise" })]), scfg);
    expect(v.decision).toBe("block");
    expect(v.modeConflict).toBe(true);
  });

  test("plain block has NO modeConflict key", () => {
    const v = evaluate(sCall(["C:/proj/engine/w1.ts"], [errFinding()]), scfg);
    expect(v.decision).toBe("block");
    expect("modeConflict" in v).toBe(false);
  });

  test("conflict among any blocked finding flags the verdict even when sorted[0] is clean", () => {
    const v = evaluate(
      sCall(
        ["C:/proj/engine/w1.ts"],
        [
          errFinding({ checkId: "a-plain", startLine: 1 }),
          errFinding({ checkId: "z-conflict", startLine: 2, status: "draft", mode: "block" }),
        ]
      ),
      scfg
    );
    expect(v.decision).toBe("block");
    expect(v.matchedIntent).toBe("a-plain");
    expect(v.modeConflict).toBe(true);
  });

  test("conflicted block message bytes identical to plain block message", () => {
    const plain = evaluate(sCall(["C:/proj/engine/w1.ts"], [errFinding()]), scfg);
    const conflicted = evaluate(
      sCall(["C:/proj/engine/w1.ts"], [errFinding({ status: "draft", mode: "block" })]),
      scfg
    );
    expect(conflicted.message).toBe(plain.message);
  });

  test("INFO + adopted still ignored (severity authoritative), allow shape untouched", () => {
    const v = evaluate(
      sCall(["C:/proj/engine/w1.ts"], [errFinding({ severity: "INFO", status: "adopted", mode: "advise" })]),
      scfg
    );
    expect(v).toEqual({ decision: "allow", verdictVersion: 2 });
  });
});

describe("composeAdvisoryDelta", () => {
  const deltaBase = (over: Partial<AdvisoryFinding> = {}): AdvisoryFinding => ({
    checkId: "engine-no-console-log",
    severity: "ERROR",
    message: "console.log left in engine code — debug output should not ship",
    startLine: 1,
    mode: "advise",
    path: "c:/proj/engine/delta.ts",
    ...over,
  });

  test("update-2 GOLDEN exact bytes", () => {
    const golden = [
      "BACKPRESSURE ADVISORY (update 2): 1 NEW finding(s) since the last advisory this session. Nothing was blocked; the writes have already landed. Advisories are re-delivered only when new findings appear (max 3 per session).",
      "WHY: Rule 'engine-no-console-log' (severity ERROR) matched: console.log left in engine code — debug output should not ship (c:/proj/engine/delta.ts, line 1).",
      "INSTEAD: Remove the console.log call or return a diagnostic value.",
      "APPEAL: If you believe a finding is wrong, state an appeal with reasons in your reply. A human reviews appeals.",
    ].join("\n");
    expect(
      composeAdvisoryDelta(
        [deltaBase({ instead: "Remove the console.log call or return a diagnostic value." })],
        2
      )
    ).toBe(golden);
  });

  test("deliveryNumber 3 header", () => {
    const text = composeAdvisoryDelta([deltaBase()], 3);
    expect(text.split("\n")[0]).toBe(
      "BACKPRESSURE ADVISORY (update 3): 1 NEW finding(s) since the last advisory this session. Nothing was blocked; the writes have already landed. Advisories are re-delivered only when new findings appear (max 3 per session)."
    );
  });

  test("multi-finding count and body ordering match composeAdvisory", () => {
    const a = deltaBase({ checkId: "z-rule", startLine: 9, path: "c:/proj/engine/z.ts" });
    const b = deltaBase({ checkId: "a-rule", startLine: 2, path: "c:/proj/engine/a.ts" });
    const delta = composeAdvisoryDelta([a, b], 2);
    expect(delta).toContain("2 NEW finding(s)");
    const plain = composeAdvisory([a, b]);
    expect(delta.split("\n").slice(1)).toEqual(plain.split("\n").slice(1));
  });

  test("cap at 10 with suppression line", () => {
    const many: AdvisoryFinding[] = [];
    for (let i = 0; i < 12; i++) {
      many.push(deltaBase({ checkId: `rule-${i}`, startLine: i, path: `c:/proj/engine/f${i}.ts` }));
    }
    const text = composeAdvisoryDelta(many, 2);
    expect((text.match(/WHY: Rule '/g) ?? []).length).toBe(10);
    expect(text).toContain("and 2 further finding(s) suppressed");
  });

  test("instead override and default INSTEAD", () => {
    expect(composeAdvisoryDelta([deltaBase({ instead: "Delta remedy." })], 2)).toContain(
      "INSTEAD: Delta remedy."
    );
    expect(composeAdvisoryDelta([deltaBase({ instead: undefined })], 2)).toContain(
      "INSTEAD: Fix the flagged patterns before continuing, or ask the user to adjust the rules in '.backpressure/rules/' if a rule is wrong."
    );
  });

  test("NOTE replaces APPEAL when any finding is not appealable", () => {
    const text = composeAdvisoryDelta(
      [
        deltaBase(),
        deltaBase({ checkId: "other", startLine: 5, appealable: false, path: "c:/proj/engine/o.ts" }),
      ],
      2
    );
    expect(text).toContain("NOTE: Some findings are not appealable.");
    expect(text).not.toContain("APPEAL:");
  });
});