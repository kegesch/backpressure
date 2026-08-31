import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import {
  inScopePath,
  type AdvisoryFinding,
  type EngineConfig,
  type SemgrepFinding,
  type SemgrepMode,
  type ToolCallDescription,
} from "./core.ts";

export interface SemgrepRunResult {
  findings: SemgrepFinding[];
  ran: boolean;
  reason?: string;
  errors?: number;
  durationMs: number;
}

export interface RescanResult {
  ran: boolean;
  reason?: string;
  findings: AdvisoryFinding[];
  durationMs: number;
}

export interface SemgrepParseResult {
  findings: SemgrepFinding[];
  errors: number;
  unparseable: boolean;
}

const RULES_SUBDIR = join(".backpressure", "rules");
const SPAWN_TIMEOUT_MS = 20000;
const MAX_BUFFER = 10 * 1024 * 1024;

function semgrepBin(): string {
  return (
    process.env.BACKPRESSURE_SEMGREP_BIN ||
    join(process.env.APPDATA ?? "", "Python", "Python313", "Scripts", "pysemgrep.exe")
  );
}

function norm(p: string): string {
  return resolve(p.replace(/\\/g, "/")).replace(/\\/g, "/").toLowerCase();
}

function toSeverity(s: unknown): string {
  return typeof s === "string" ? s.toUpperCase() : "INFO";
}

function toMode(v: unknown): SemgrepMode | undefined {
  if (typeof v !== "string") return undefined;
  const m = v.toLowerCase();
  return m === "advise" ? "advise" : m === "block" ? "block" : undefined;
}

function toStatus(v: unknown): string | undefined {
  return typeof v === "string" ? v.toLowerCase() : undefined;
}

interface ParsedSemgrepItem {
  rawPath: string;
  finding: SemgrepFinding;
}

function parseSemgrepResults(parsed: unknown): { items: ParsedSemgrepItem[]; errors: number } {
  const root = (parsed ?? {}) as Record<string, unknown>;
  const results = Array.isArray(root.results) ? (root.results as unknown[]) : [];
  const items: ParsedSemgrepItem[] = [];
  for (const r of results) {
    if (r === null || typeof r !== "object") continue;
    const rec = r as Record<string, unknown>;
    const checkId = typeof rec.check_id === "string" ? rec.check_id : "";
    if (!checkId) continue;
    const extra = (rec.extra ?? {}) as Record<string, unknown>;
    const start = (rec.start ?? {}) as Record<string, unknown>;
    const metadata = (extra.metadata ?? {}) as Record<string, unknown>;
    const bp = (metadata.backpressure ?? {}) as Record<string, unknown>;
    items.push({
      rawPath: typeof rec.path === "string" ? rec.path : "",
      finding: {
        checkId: checkId.slice(checkId.lastIndexOf(".") + 1) || checkId,
        severity: toSeverity(extra.severity),
        message: typeof extra.message === "string" ? extra.message : undefined,
        startLine: typeof start.line === "number" ? start.line : undefined,
        why: typeof bp.why === "string" ? bp.why : undefined,
        instead: typeof bp.instead === "string" ? bp.instead : undefined,
        appealable: typeof bp.appealable === "boolean" ? bp.appealable : undefined,
        mode: toMode(bp.mode),
        status: toStatus(bp.status),
      },
    });
  }
  const errors = Array.isArray(root.errors) ? (root.errors as unknown[]).length : 0;
  return { items, errors };
}

export function parseSemgrepJson(stdout: string): SemgrepParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { findings: [], errors: -1, unparseable: true };
  }
  const { items, errors } = parseSemgrepResults(parsed);
  return { findings: items.map((i) => i.finding), errors, unparseable: false };
}

export async function runSemgrepGate(
  call: ToolCallDescription,
  config: EngineConfig
): Promise<SemgrepRunResult> {
  const started = Date.now();
  const rulesDir = config.rulesDir ?? join(config.protectedRoot, RULES_SUBDIR);
  let ruleFiles: string[] = [];
  try {
    ruleFiles = readdirSync(rulesDir).filter((f) => /\.(ya?ml)$/i.test(f));
  } catch {
    return { findings: [], ran: false, reason: "no-rules", durationMs: Date.now() - started };
  }
  if (ruleFiles.length === 0) {
    return { findings: [], ran: false, reason: "no-rules", durationMs: Date.now() - started };
  }
  const path = inScopePath(call, config);
  if (!path) {
    return { findings: [], ran: false, reason: "out-of-scope", durationMs: Date.now() - started };
  }
  const text = call.tool === "write" ? call.content : call.newText;
  if (typeof text !== "string" || text === "") {
    return { findings: [], ran: false, reason: "no-candidate", durationMs: Date.now() - started };
  }
  const bin = semgrepBin();
  if (!existsSync(bin)) {
    return { findings: [], ran: false, reason: "no-bin", durationMs: Date.now() - started };
  }
  const orig = call.paths.find(
    (p) => norm(resolve(call.workdir, p.replace(/\\/g, "/"))) === path
  );
  const rel =
    orig !== undefined
      ? relative(call.workdir, resolve(call.workdir, orig.replace(/\\/g, "/")))
      : relative(call.workdir, path);
  const relNorm = rel.split(/[\\/]/).join("/");
  const slug = String(call.workdir).replace(/[^a-zA-Z0-9._-]/g, "_");
  const scratchRoot = join(tmpdir(), "opencode", "bp-scan", slug);
  const scratchFile = join(scratchRoot, relNorm);
  try {
    mkdirSync(dirname(scratchFile), { recursive: true });
    writeFileSync(scratchFile, text, "utf8");
    const parsed = await new Promise<SemgrepParseResult>((resolveP, rejectP) => {
      execFile(
        bin,
        [
          "scan",
          "--config",
          rulesDir,
          "--json",
          "--metrics=off",
          "--quiet",
          "--disable-version-check",
          scratchRoot,
        ],
        {
          timeout: SPAWN_TIMEOUT_MS,
          maxBuffer: MAX_BUFFER,
          windowsHide: true,
          env: { ...process.env, SEMGREP_SEND_METRICS: "off", PYTHONUTF8: "1" },
        },
        (err, out) => {
          const p = parseSemgrepJson(out ?? "");
          if (!p.unparseable) {
            resolveP(p);
            return;
          }
          if (err) {
            const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
            if (e.killed) rejectP(new Error("timeout"));
            else rejectP(new Error(`semgrep failed: ${e.message}`));
            return;
          }
          rejectP(new Error("semgrep produced unparseable output"));
        }
      );
    });
    const result: SemgrepRunResult = {
      findings: parsed.findings,
      ran: true,
      durationMs: Date.now() - started,
    };
    if (parsed.errors > 0) {
      result.errors = parsed.errors;
      result.reason = "rule-errors";
    }
    return result;
  } catch (err) {
    return {
      findings: [],
      ran: true,
      reason: String((err as Error).message || err),
      durationMs: Date.now() - started,
    };
  } finally {
    try {
      rmSync(scratchRoot, { recursive: true, force: true });
    } catch {
    }
  }
}

export async function runSemgrepRescan(
  files: string[],
  config: EngineConfig
): Promise<RescanResult> {
  const started = Date.now();
  const scratchRoot = join(
    tmpdir(),
    "opencode",
    "bp-scan",
    String(config.protectedRoot).replace(/[^a-zA-Z0-9._-]/g, "_")
  );
  const fail = (reason: string): RescanResult => ({
    ran: false,
    reason,
    findings: [],
    durationMs: Date.now() - started,
  });
  try {
    if (files.length === 0) return fail("no-files");
    const rulesDir = config.rulesDir ?? join(config.protectedRoot, RULES_SUBDIR);
    let ruleFiles: string[] = [];
    try {
      ruleFiles = readdirSync(rulesDir).filter((f) => /\.(ya?ml)$/i.test(f));
    } catch {
      return fail("no-rules");
    }
    if (ruleFiles.length === 0) return fail("no-rules");
    const bin = semgrepBin();
    if (!existsSync(bin)) return fail("no-bin");
    const scratchToReal = new Map<string, string>();
    let laidOut = 0;
    for (const file of files) {
      const real = norm(file);
      if (!existsSync(real)) continue;
      const rel = relative(config.protectedRoot, real);
      if (rel === "" || rel.startsWith("..")) continue;
      const relNorm = rel.split(/[\\/]/).join("/");
      const scratchFile = join(scratchRoot, relNorm);
      try {
        mkdirSync(dirname(scratchFile), { recursive: true });
        writeFileSync(scratchFile, readFileSync(real, "utf8"), "utf8");
      } catch {
        continue;
      }
      scratchToReal.set(norm(scratchFile), real);
      laidOut++;
    }
    if (laidOut === 0) return fail("no-files");
    const parsed = await new Promise<{ items: ParsedSemgrepItem[]; errors: number }>(
      (resolveP, rejectP) => {
        execFile(
          bin,
          [
            "scan",
            "--config",
            rulesDir,
            "--json",
            "--metrics=off",
            "--quiet",
            "--disable-version-check",
            scratchRoot,
          ],
          {
            timeout: SPAWN_TIMEOUT_MS,
            maxBuffer: MAX_BUFFER,
            windowsHide: true,
            env: { ...process.env, SEMGREP_SEND_METRICS: "off", PYTHONUTF8: "1" },
          },
          (err, out) => {
            let parsedJson: unknown;
            try {
              parsedJson = JSON.parse(out ?? "");
            } catch {
              parsedJson = undefined;
            }
            if (parsedJson !== undefined) {
              resolveP(parseSemgrepResults(parsedJson));
              return;
            }
            const e = err as NodeJS.ErrnoException & { killed?: boolean };
            if (e?.killed) rejectP(new Error("timeout"));
            else if (err) rejectP(new Error(`semgrep failed: ${e.message}`));
            else rejectP(new Error("semgrep produced unparseable output"));
          }
        );
      }
    );
    const findings: AdvisoryFinding[] = [];
    for (const item of parsed.items) {
      if (!item.rawPath) continue;
      let real = scratchToReal.get(norm(item.rawPath));
      if (real === undefined) {
        const relFromRoot = relative(scratchRoot, item.rawPath);
        if (relFromRoot !== "" && !relFromRoot.startsWith("..")) {
          real = norm(resolve(config.protectedRoot, relFromRoot));
        }
      }
      if (real === undefined) continue;
      findings.push({ ...item.finding, path: real });
    }
    const result: RescanResult = {
      ran: true,
      findings,
      durationMs: Date.now() - started,
    };
    if (parsed.errors > 0) result.reason = "rule-errors";
    return result;
  } catch (err) {
    return {
      ran: true,
      reason: String((err as Error).message || err),
      findings: [],
      durationMs: Date.now() - started,
    };
  } finally {
    try {
      rmSync(scratchRoot, { recursive: true, force: true });
    } catch {
    }
  }
}