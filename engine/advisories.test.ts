import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  collectAdvisories,
  deliveryCount,
  getAdvisories,
  getScanScope,
  clearAdvisories,
  clearAllAdvisories,
  incrementDelivery,
  markDelivered,
  noteScanScope,
  MAX_DELIVERIES_PER_SESSION,
  MAX_PER_SESSION,
  SCAN_SCOPE_CAP,
} from "./advisories.ts";
import type { AdvisoryFinding } from "./core.ts";

const f = (over: Partial<AdvisoryFinding> = {}): AdvisoryFinding => ({
  checkId: "r1",
  severity: "ERROR",
  message: "m",
  startLine: 1,
  path: "engine/x.ts",
  ...over,
});

describe("advisories store", () => {
  test("roundtrip collect then get", () => {
    clearAllAdvisories();
    const stored = collectAdvisories("s1", [f()]);
    expect(stored).toBe(1);
    const got = getAdvisories("s1");
    expect(got).toHaveLength(1);
    expect(got[0].checkId).toBe("r1");
    expect(got[0].path).toBe("engine/x.ts");
    clearAllAdvisories();
  });

  test("unknown session returns []", () => {
    clearAllAdvisories();
    expect(getAdvisories("nope")).toEqual([]);
    clearAllAdvisories();
  });

  test("dedupe same key collects once", () => {
    clearAllAdvisories();
    expect(collectAdvisories("s2", [f(), f()])).toBe(1);
    expect(collectAdvisories("s2", [f()])).toBe(0);
    expect(getAdvisories("s2")).toHaveLength(1);
    clearAllAdvisories();
  });

  test("distinct key parts are distinct entries", () => {
    clearAllAdvisories();
    const a = f({ checkId: "r1", path: "engine/a.ts", startLine: 1 });
    const b = f({ checkId: "r1", path: "engine/b.ts", startLine: 1 });
    const c = f({ checkId: "r1", path: "engine/a.ts", startLine: 9 });
    const d = f({ checkId: "r2", path: "engine/a.ts", startLine: 1 });
    expect(collectAdvisories("s3", [a, b, c, d])).toBe(4);
    clearAllAdvisories();
  });

  test("missing startLine normalizes to 0", () => {
    clearAllAdvisories();
    const a = f({ startLine: undefined });
    const b = f({ startLine: 0 });
    expect(collectAdvisories("s4", [a, b])).toBe(1);
    clearAllAdvisories();
  });

  test("cap at MAX_PER_SESSION drops the 51st", () => {
    clearAllAdvisories();
    const many: AdvisoryFinding[] = [];
    for (let i = 0; i < MAX_PER_SESSION + 1; i++) {
      many.push(f({ checkId: `r${i}`, startLine: i }));
    }
    expect(collectAdvisories("s5", many)).toBe(MAX_PER_SESSION);
    expect(getAdvisories("s5")).toHaveLength(MAX_PER_SESSION);
    clearAllAdvisories();
  });

  test("multi-session isolation", () => {
    clearAllAdvisories();
    collectAdvisories("s6", [f()]);
    collectAdvisories("s7", [f({ checkId: "other" })]);
    const got6 = getAdvisories("s6");
    const got7 = getAdvisories("s7");
    expect(got6).toHaveLength(1);
    expect(got6[0].checkId).toBe("r1");
    expect(got7).toHaveLength(1);
    expect(got7[0].checkId).toBe("other");
    clearAllAdvisories();
  });

  test("clear consumes and unknown session clear is no-op", () => {
    clearAllAdvisories();
    collectAdvisories("s8", [f()]);
    clearAdvisories("s8");
    expect(getAdvisories("s8")).toEqual([]);
    clearAdvisories("s8");
    clearAdvisories("never-existed");
    clearAllAdvisories();
  });

  test("clearAll empties everything", () => {
    clearAllAdvisories();
    collectAdvisories("s9", [f()]);
    collectAdvisories("s10", [f()]);
    clearAllAdvisories();
    expect(getAdvisories("s9")).toEqual([]);
    expect(getAdvisories("s10")).toEqual([]);
  });

  test("ordering determinism severity then line then checkId", () => {
    clearAllAdvisories();
    collectAdvisories("s11", [
      f({ checkId: "z", startLine: 9 }),
      f({ checkId: "a", startLine: 2 }),
      f({ checkId: "w", severity: "WARNING", startLine: 1 }),
    ]);
    const got = getAdvisories("s11");
    expect(got.map((x) => x.checkId)).toEqual(["a", "z", "w"]);
    clearAllAdvisories();
  });
});

describe("advisories purity", () => {
  test("advisories.ts imports no node:fs or child_process", () => {
    const src = readFileSync(join(import.meta.dir, "advisories.ts"), "utf8");
    expect(src).not.toMatch(/from\s+["']node:fs["']/);
    expect(src).not.toMatch(/from\s+["']node:child_process["']/);
  });
});

describe("delivery bookkeeping (iter13)", () => {
  test("constants pinned: MAX_DELIVERIES_PER_SESSION 3, SCAN_SCOPE_CAP 20", () => {
    expect(MAX_DELIVERIES_PER_SESSION).toBe(3);
    expect(SCAN_SCOPE_CAP).toBe(20);
  });

  test("collect after markDelivered: same key absorbed, new key stored", () => {
    clearAllAdvisories();
    const first = f({ checkId: "r1", path: "engine/a.ts", startLine: 1 });
    expect(collectAdvisories("d1", [first])).toBe(1);
    markDelivered("d1", [first]);
    expect(getAdvisories("d1")).toEqual([]);
    expect(collectAdvisories("d1", [f({ checkId: "r1", path: "engine/a.ts", startLine: 1 })])).toBe(0);
    expect(collectAdvisories("d1", [f({ checkId: "r1", path: "engine/b.ts", startLine: 1 })])).toBe(1);
    clearAllAdvisories();
  });

  test("deliveryCount increments via incrementDelivery and resets on clearAll", () => {
    clearAllAdvisories();
    expect(deliveryCount("d2")).toBe(0);
    expect(incrementDelivery("d2")).toBe(1);
    expect(incrementDelivery("d2")).toBe(2);
    expect(deliveryCount("d2")).toBe(2);
    clearAllAdvisories();
    expect(deliveryCount("d2")).toBe(0);
  });

  test("pending store unaffected by deliveries at cap (collect still stores)", () => {
    clearAllAdvisories();
    incrementDelivery("d3");
    incrementDelivery("d3");
    incrementDelivery("d3");
    expect(collectAdvisories("d3", [f()])).toBe(1);
    expect(getAdvisories("d3")).toHaveLength(1);
    clearAllAdvisories();
  });

  test("delivered keys do not block distinct pending keys in the same collect", () => {
    clearAllAdvisories();
    const delivered = f({ checkId: "r1", path: "engine/a.ts", startLine: 1 });
    collectAdvisories("d4", [delivered]);
    markDelivered("d4", [delivered]);
    expect(collectAdvisories("d4", [delivered, f({ checkId: "r2", startLine: 2 })])).toBe(1);
    expect(getAdvisories("d4").map((x) => x.checkId)).toEqual(["r2"]);
    clearAllAdvisories();
  });

  test("markDelivered keeps scanScope", () => {
    clearAllAdvisories();
    noteScanScope("d5", "engine/a.ts");
    collectAdvisories("d5", [f()]);
    markDelivered("d5", [f()]);
    expect(getScanScope("d5")).toEqual(["engine/a.ts"]);
    clearAllAdvisories();
  });

  test("multi-session isolation for deliveries and scope", () => {
    clearAllAdvisories();
    incrementDelivery("d6a");
    incrementDelivery("d6b");
    incrementDelivery("d6b");
    noteScanScope("d6a", "engine/a.ts");
    noteScanScope("d6b", "engine/b.ts");
    expect(deliveryCount("d6a")).toBe(1);
    expect(deliveryCount("d6b")).toBe(2);
    expect(getScanScope("d6a")).toEqual(["engine/a.ts"]);
    expect(getScanScope("d6b")).toEqual(["engine/b.ts"]);
    clearAllAdvisories();
  });
});

describe("scan scope (iter13)", () => {
  test("re-note dedupes and refreshes recency", () => {
    clearAllAdvisories();
    noteScanScope("s1", "engine/a.ts");
    noteScanScope("s1", "engine/b.ts");
    noteScanScope("s1", "engine/a.ts");
    expect(getScanScope("s1")).toEqual(["engine/b.ts", "engine/a.ts"]);
    clearAllAdvisories();
  });

  test("cap at SCAN_SCOPE_CAP evicts least-recent", () => {
    clearAllAdvisories();
    for (let i = 0; i < SCAN_SCOPE_CAP + 2; i++) noteScanScope("s2", `engine/f${i}.ts`);
    const scope = getScanScope("s2");
    expect(scope).toHaveLength(SCAN_SCOPE_CAP);
    expect(scope[0]).toBe("engine/f2.ts");
    expect(scope[scope.length - 1]).toBe(`engine/f${SCAN_SCOPE_CAP + 1}.ts`);
    clearAllAdvisories();
  });

  test("getScanScope returns a copy", () => {
    clearAllAdvisories();
    noteScanScope("s3", "engine/a.ts");
    const scope = getScanScope("s3");
    scope.push("engine/injected.ts");
    expect(getScanScope("s3")).toEqual(["engine/a.ts"]);
    clearAllAdvisories();
  });

  test("empty path ignored; unknown session returns []", () => {
    clearAllAdvisories();
    noteScanScope("s4", "");
    expect(getScanScope("s4")).toEqual([]);
    expect(getScanScope("nope")).toEqual([]);
    clearAllAdvisories();
  });
});

describe("session reset semantics (iter13)", () => {
  test("clearAdvisories resets store, deliveries, delivered keys and scope", () => {
    clearAllAdvisories();
    collectAdvisories("r1", [f()]);
    incrementDelivery("r1");
    noteScanScope("r1", "engine/a.ts");
    markDelivered("r1", [f()]);
    expect(collectAdvisories("r1", [f()])).toBe(0);
    clearAdvisories("r1");
    expect(getAdvisories("r1")).toEqual([]);
    expect(deliveryCount("r1")).toBe(0);
    expect(getScanScope("r1")).toEqual([]);
    expect(collectAdvisories("r1", [f()])).toBe(1);
    clearAllAdvisories();
  });
});

describe("mixed semgrep + sensor collect (iter15)", () => {
  test("merged collect orders by compareFindings and carries sensor fields", () => {
    clearAllAdvisories();
    const sn = {
      checkId: "no-unused-vars",
      severity: "ERROR",
      message: "'x' is assigned a value but never used",
      startLine: 9,
      sensorId: "eslint",
      path: "engine/sn.ts",
    } as AdvisoryFinding;
    const stored = collectAdvisories("s-sn", [sn, f({ checkId: "no-eval", startLine: 2 })]);
    expect(stored).toBe(2);
    const got = getAdvisories("s-sn");
    expect(got.map((x) => x.checkId)).toEqual(["no-eval", "no-unused-vars"]);
    expect(got[1].sensorId).toBe("eslint");
    clearAllAdvisories();
  });
});