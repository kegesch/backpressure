import { resolve } from "node:path";

export type EngineDecision = "block" | "allow";
export type EngineRuleId = "tool-path" | "shell-write" | "semgrep" | "sensor";
export type SemgrepMode = "block" | "advise";
export type RuleStatus = "draft" | "adopted";

export interface SemgrepFinding {
  checkId: string;
  severity: string;
  message?: string;
  startLine?: number;
  why?: string;
  instead?: string;
  appealable?: boolean;
  mode?: SemgrepMode;
  status?: string;
}

export interface SensorFinding extends SemgrepFinding {
  sensorId: string;
  toolRule?: string;
}

export interface AdvisoryFinding extends SemgrepFinding {
  path: string;
}

export interface ToolCallDescription {
  tool: string;
  paths: string[];
  command?: string;
  workdir: string;
  content?: string;
  newText?: string;
  semgrepFindings?: SemgrepFinding[];
  sensorFindings?: SensorFinding[];
}

export interface EngineConfig {
  protectedRoot: string;
  qualityRoots?: string[];
  rulesDir?: string;
  sensorsDir?: string;
}

export interface EngineVerdict {
  decision: EngineDecision;
  rule?: EngineRuleId;
  matchedIntent?: string;
  reason?: string;
  detail?: string;
  message?: string;
  appealable?: boolean;
  modeConflict?: boolean;
  verdictVersion: number;
}

const BLOCK_MESSAGE = [
  "BACKPRESSURE VERDICT: BLOCK (rule protected-path: write/edit to '.backpressure/**').",
  "WHY: '.backpressure/' holds the backpressure engine's own enforcement and audit state (hook log, verdicts, future ratchet store). Writes by agents could tamper with the referee that judges their work, so this path is protected.",
  "INSTEAD: Write scratch and validation files to the workdir (e.g. 'iter5-validation/'). This block is not a challenge to route around: writing a file elsewhere and then copying or moving it into '.backpressure/' is a violation, not a workaround.",
  "APPEAL: If you believe this write is genuinely needed, state an appeal with reasons in your final reply. A human reviews appeals.",
].join("\n");

const SHELL_BLOCK_MESSAGE = [
  "BACKPRESSURE VERDICT: BLOCK (rule shell-write: shell command writes into '.backpressure/**').",
  "WHY: '.backpressure/' holds the backpressure engine's own enforcement and audit state (hook log, verdicts, future ratchet store). Writes by agents could tamper with the referee that judges their work, so this path is protected.",
  "INSTEAD: Write scratch and validation files to the workdir (e.g. 'iter5-validation/'). This block is not a challenge to route around: writing a file elsewhere and then copying or moving it into '.backpressure/' is a violation, not a workaround.",
  "APPEAL: If you believe this write is genuinely needed, state an appeal with reasons in your final reply. A human reviews appeals.",
].join("\n");

const DEFAULT_SEMGREP_INSTEAD =
  "Fix the pattern violation identified by the rule, or ask the user to adjust the rule in '.backpressure/rules/' if it is wrong.";
const DEFAULT_SENSOR_INSTEAD =
  "Fix the finding reported by the sensor, or ask the user to adjust the sensor in '.backpressure/sensors/' if it is wrong.";
const SENSOR_MESSAGE_FALLBACK = "a policy violation in the candidate content.";
const SEMGREP_APPEAL =
  "APPEAL: If you believe this write is genuinely needed, state an appeal with reasons in your final reply. A human reviews appeals.";
const SEMGREP_NO_APPEAL =
  "NOTE: This block is not appealable. Contact a human maintainer if you believe the rule is wrong.";

interface HardGateRule {
  id: EngineRuleId;
  check(call: ToolCallDescription, config: EngineConfig): EngineVerdict | null;
}

function normalizePath(p: string): string {
  return resolve(p.replace(/\\/g, "/")).replace(/\\/g, "/").toLowerCase();
}

function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (const ch of pattern) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else if ("+.^${}()|[]\\".includes(ch)) re += `\\${ch}`;
    else re += ch;
  }
  return new RegExp(`^${re}$`);
}

export function globMatch(pattern: string, rel: string): boolean {
  const p = pattern.replace(/\\/g, "/");
  const r = rel.replace(/\\/g, "/");
  if (p.endsWith("/**")) {
    const base = p.slice(0, -3);
    return base === "" || r.startsWith(base + "/");
  }
  if (p.startsWith("**/")) {
    const tail = p.slice(3);
    const parts = r.split("/");
    const tailRe = globToRegExp(tail);
    for (let i = 0; i < parts.length; i++) {
      if (tailRe.test(parts.slice(i).join("/"))) return true;
    }
    return false;
  }
  return r === p;
}

export function inScopePath(call: ToolCallDescription, config: EngineConfig): string | null {
  if (!config.qualityRoots || config.qualityRoots.length === 0) return null;
  const roots = config.qualityRoots.map((r) => {
    const n = normalizePath(r);
    return n.endsWith("/") ? n : n + "/";
  });
  for (const p of call.paths) {
    const resolved = normalizePath(resolve(call.workdir, p.replace(/\\/g, "/")));
    if (roots.some((r) => resolved.startsWith(r)) && /\.ts$/.test(resolved)) return resolved;
  }
  return null;
}

function isBlockingSeverity(severity: string): boolean {
  const s = severity.toUpperCase();
  return s === "ERROR" || s === "WARNING";
}

function severityRank(severity: string): number {
  return severity.toUpperCase() === "ERROR" ? 0 : 1;
}

export function compareFindings(a: SemgrepFinding, b: SemgrepFinding): number {
  const ar = severityRank(a.severity);
  const br = severityRank(b.severity);
  if (ar !== br) return ar - br;
  const al = a.startLine ?? Number.MAX_SAFE_INTEGER;
  const bl = b.startLine ?? Number.MAX_SAFE_INTEGER;
  if (al !== bl) return al - bl;
  return a.checkId.localeCompare(b.checkId);
}

export const MAX_DELIVERIES_PER_SESSION = 3;

export function resolveRuleMode(
  status?: string,
  mode?: SemgrepMode
): { mode: SemgrepMode; conflict: boolean } {
  const s = typeof status === "string" ? status.toLowerCase() : undefined;
  if (s === undefined) {
    return { mode: mode ?? "block", conflict: false };
  }
  if (s === "draft") {
    if (mode === "block") return { mode: "block", conflict: true };
    return { mode: "advise", conflict: false };
  }
  if (s === "adopted") {
    if (mode === "advise") return { mode: "block", conflict: true };
    return { mode: "block", conflict: false };
  }
  return { mode: "block", conflict: true };
}

export function partitionSemgrepFindings(
  findings: SemgrepFinding[]
): { block: SemgrepFinding[]; advise: SemgrepFinding[]; ignored: SemgrepFinding[] } {
  const block: SemgrepFinding[] = [];
  const advise: SemgrepFinding[] = [];
  const ignored: SemgrepFinding[] = [];
  for (const f of findings) {
    if (!isBlockingSeverity(f.severity)) {
      ignored.push(f);
    } else if (resolveRuleMode(f.status, f.mode).mode === "advise") {
      advise.push(f);
    } else {
      block.push(f);
    }
  }
  return { block, advise, ignored };
}

const ADVISORY_DEFAULT_INSTEAD =
  "Fix the flagged patterns before continuing, or ask the user to adjust the rules in '.backpressure/rules/' if a rule is wrong.";
const ADVISORY_APPEAL =
  "APPEAL: If you believe a finding is wrong, state an appeal with reasons in your reply. A human reviews appeals.";
const ADVISORY_NO_APPEAL =
  "NOTE: Some findings are not appealable. Contact a human maintainer if you believe such a rule is wrong.";

function advisoryBodyLines(findings: AdvisoryFinding[]): string[] {
  const sorted = [...findings].sort(compareFindings);
  const lines: string[] = [];
  const shown = sorted.slice(0, 10);
  for (const f of shown) {
    const msg = f.message !== undefined ? f.message : "matched a pattern violation in the candidate content.";
    const loc = typeof f.startLine === "number" ? `, line ${f.startLine}` : "";
    lines.push(
      `WHY: Rule '${f.checkId}' (severity ${f.severity.toUpperCase()}) matched: ${msg} (${f.path}${loc}).`
    );
  }
  if (sorted.length > 10) {
    lines.push(
      `WHY: … and ${sorted.length - 10} further finding(s) suppressed (see '.backpressure/hook-log.jsonl' probe.advise.collect entries).`
    );
  }
  const firstInstead = sorted.find((f) => f.instead !== undefined && f.instead !== "");
  lines.push(firstInstead ? `INSTEAD: ${firstInstead.instead}` : `INSTEAD: ${ADVISORY_DEFAULT_INSTEAD}`);
  lines.push(sorted.some((f) => f.appealable === false) ? ADVISORY_NO_APPEAL : ADVISORY_APPEAL);
  return lines;
}

export function composeAdvisory(findings: AdvisoryFinding[]): string {
  const header = `BACKPRESSURE ADVISORY: advise-mode rule(s) matched content written this session (${findings.length} finding(s)). Nothing was blocked; the writes have already landed. This advisory is delivered once per session.`;
  return [header, ...advisoryBodyLines(findings)].join("\n");
}

export function composeAdvisoryDelta(findings: AdvisoryFinding[], deliveryNumber: number): string {
  const header = `BACKPRESSURE ADVISORY (update ${deliveryNumber}): ${findings.length} NEW finding(s) since the last advisory this session. Nothing was blocked; the writes have already landed. Advisories are re-delivered only when new findings appear (max ${MAX_DELIVERIES_PER_SESSION} per session).`;
  return [header, ...advisoryBodyLines(findings)].join("\n");
}

function semgrepBlockMessage(f: SemgrepFinding): string {
  return [
    `BACKPRESSURE VERDICT: BLOCK (rule semgrep: '${f.checkId}').`,
    f.why
      ? `WHY: ${f.why}`
      : `WHY: Semgrep rule '${f.checkId}' (severity ${f.severity.toUpperCase()}) matched${
          f.message ? `: ${f.message}` : " a pattern violation in the candidate content."
        }`,
    f.instead ? `INSTEAD: ${f.instead}` : `INSTEAD: ${DEFAULT_SEMGREP_INSTEAD}`,
    f.appealable === false ? SEMGREP_NO_APPEAL : SEMGREP_APPEAL,
  ].join("\n");
}

function sensorBlockMessage(f: SensorFinding): string {
  return [
    `BACKPRESSURE VERDICT: BLOCK (rule sensor: '${f.checkId}').`,
    f.why
      ? `WHY: ${f.why}`
      : `WHY: Sensor '${f.sensorId}' rule '${f.checkId}' (severity ${f.severity.toUpperCase()}) matched: ${
          f.message !== undefined && f.message !== "" ? f.message : SENSOR_MESSAGE_FALLBACK
        }`,
    f.instead ? `INSTEAD: ${f.instead}` : `INSTEAD: ${DEFAULT_SENSOR_INSTEAD}`,
    f.appealable === false ? SEMGREP_NO_APPEAL : SEMGREP_APPEAL,
  ].join("\n");
}

const rules: HardGateRule[] = [
  {
    id: "tool-path",
    check(call, config) {
      if (call.tool !== "write" && call.tool !== "edit") return null;
      const prefix = (config.protectedRoot.replace(/\\/g, "/") + "/.backpressure/").toLowerCase();
      for (const p of call.paths) {
        const resolved = resolve(call.workdir, p.replace(/\\/g, "/"))
          .replace(/\\/g, "/")
          .toLowerCase();
        if (resolved.startsWith(prefix)) {
          return {
            decision: "block",
            rule: "tool-path",
            matchedIntent: "protected-path",
            reason: "protected path .backpressure/**",
            detail: resolved,
            message: BLOCK_MESSAGE,
            appealable: true,
            verdictVersion: 2,
          };
        }
      }
      return null;
    },
  },
  {
    id: "shell-write",
    check(call, config) {
      if (call.tool !== "bash" || typeof call.command !== "string") return null;
      const cmd = call.command;
      if (!cmd.toLowerCase().includes(".backpressure")) return null;
      const unquoted = cmd.replace(/'[^']*'/g, " ").replace(/"[^"]*"/g, " ");
      const lower = unquoted.toLowerCase();
      const tokens = lower.split(/[^a-z0-9._-]+/).filter(Boolean);
      const writeTokens = new Set([
        "copy-item",
        "move-item",
        "remove-item",
        "new-item",
        "set-content",
        "add-content",
        "out-file",
        "tee-object",
        "cpi",
        "mi",
        "sc",
        "ni",
        "md",
        "mkdir",
        "cp",
        "copy",
        "mv",
        "move",
        "rm",
        "del",
        "erase",
        "touch",
        "tee",
        "install",
        "ri",
        "ac",
        "clear-content",
        "rmdir",
        "rd",
        "xcopy",
        "robocopy",
        "dd",
        "rsync",
      ]);
      let matchedIntent: string | null = null;
      for (const t of tokens) {
        if (writeTokens.has(t)) {
          matchedIntent = t;
          break;
        }
      }
      if (matchedIntent == null && /(^|\s)sed\s+(-[\w.]*i[\w.]*|--in-place)(\s|$)/.test(lower)) {
        matchedIntent = "sed-in-place";
      }
      if (matchedIntent == null && /(^|[^\w.\->=])>{1,2}(?![&=])/.test(unquoted)) {
        matchedIntent = "redirect";
      }
      if (matchedIntent == null) return null;
      return {
        decision: "block",
        rule: "shell-write",
        matchedIntent,
        reason: "shell write-intent targeting .backpressure/**",
        detail: cmd.slice(0, 200),
        message: SHELL_BLOCK_MESSAGE,
        appealable: true,
        verdictVersion: 2,
      };
    },
  },
  {
    id: "semgrep",
    check(call, config) {
      if (call.tool !== "write" && call.tool !== "edit") return null;
      const path = inScopePath(call, config);
      if (!path) return null;
      const partitioned = partitionSemgrepFindings(call.semgrepFindings ?? []);
      const findings = partitioned.block;
      if (findings.length === 0) return null;
      const sorted = [...findings].sort(compareFindings);
      const f = sorted[0];
      const modeConflict = findings.some((x) => resolveRuleMode(x.status, x.mode).conflict);
      const reasonParts: string[] = [];
      if (f.message) reasonParts.push(f.message);
      if (typeof f.startLine === "number") reasonParts.push(`(line ${f.startLine})`);
      const reason = reasonParts.length > 0 ? reasonParts.join(" ") : `semgrep rule '${f.checkId}' matched`;
      return {
        decision: "block",
        rule: "semgrep",
        matchedIntent: f.checkId.slice(0, 100),
        reason,
        detail: path,
        message: semgrepBlockMessage(f),
        appealable: f.appealable !== false,
        ...(modeConflict ? { modeConflict: true } : {}),
        verdictVersion: 2,
      };
    },
  },
  {
    id: "sensor",
    check(call) {
      if (call.tool !== "write" && call.tool !== "edit") return null;
      const partitioned = partitionSemgrepFindings(call.sensorFindings ?? []);
      const findings = partitioned.block;
      if (findings.length === 0) return null;
      const sorted = [...findings].sort(compareFindings);
      const f = sorted[0] as SensorFinding;
      const modeConflict = findings.some((x) => resolveRuleMode(x.status, x.mode).conflict);
      const reasonParts: string[] = [];
      if (f.message) reasonParts.push(f.message);
      if (typeof f.startLine === "number") reasonParts.push(`(line ${f.startLine})`);
      const reason =
        reasonParts.length > 0 ? reasonParts.join(" ") : `sensor '${f.sensorId}' matched`;
      const detail =
        call.paths.length > 0
          ? normalizePath(resolve(call.workdir, call.paths[0].replace(/\\/g, "/")))
          : normalizePath(call.workdir);
      return {
        decision: "block",
        rule: "sensor",
        matchedIntent: f.checkId.slice(0, 100),
        reason,
        detail,
        message: sensorBlockMessage(f),
        appealable: f.appealable !== false,
        ...(modeConflict ? { modeConflict: true } : {}),
        verdictVersion: 2,
      };
    },
  },
];

export function evaluate(call: ToolCallDescription, config: EngineConfig): EngineVerdict {
  for (const rule of rules) {
    const verdict = rule.check(call, config);
    if (verdict !== null) return verdict;
  }
  return { decision: "allow", verdictVersion: 2 };
}