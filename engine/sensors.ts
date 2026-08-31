import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  globMatch,
  type EngineConfig,
  type SemgrepMode,
  type SensorFinding,
  type ToolCallDescription,
} from "./core.ts";

export const MAX_SENSORS = 10;
const MAX_BUFFER = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20000;
const SENSORS_SUBDIR = join(".backpressure", "sensors");

export type YamlValue = string | YamlValue[] | { [key: string]: YamlValue };

export interface SensorConfig {
  id: string;
  description?: string;
  command: string[];
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string>;
  include: string[];
  exclude: string[];
  tools: string[];
  formatType: string;
  findingsPath: string;
  fields: { ruleId: string; path: string; line: string; message: string; severity: string };
  pattern?: string;
  exitCodes: number[];
  severityMap: Record<string, string>;
  severityDefault: string;
  defaults: { why?: string; instead?: string; appealable?: boolean };
  lifecycle: { status?: string; mode?: SemgrepMode };
  sensorDir: string;
  file: string;
}

export interface SensorRunEntry {
  sensorId: string;
  ran: boolean;
  reason?: string;
  findings: (SensorFinding & { path: string })[];
  durationMs: number;
}

export interface SensorConfigError {
  file: string;
  error: string;
}

export interface SensorGateResult {
  entries: SensorRunEntry[];
  configErrors: SensorConfigError[];
  findings: (SensorFinding & { path: string })[];
  scopePath?: string;
}

export interface SensorRescanResult {
  ran: boolean;
  reason?: string;
  findings: (SensorFinding & { path: string })[];
  durationMs: number;
  configErrors: SensorConfigError[];
}

interface RawFinding {
  ruleId?: unknown;
  path?: unknown;
  line?: unknown;
  message?: unknown;
  severity?: unknown;
}

function norm(p: string): string {
  return resolve(p.replace(/\\/g, "/")).replace(/\\/g, "/").toLowerCase();
}

interface YamlLine {
  indent: number;
  content: string;
}

function stripComment(line: string): string {
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && (i === 0 || line[i - 1] !== "\\")) inQuote = !inQuote;
    else if (ch === "#" && !inQuote && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) {
      return line.slice(0, i);
    }
  }
  return line;
}

function splitTopLevel(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inQuote = false;
  let current = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' && (i === 0 || text[i - 1] !== "\\")) inQuote = !inQuote;
    if (!inQuote) {
      if (ch === "[" || ch === "{") depth++;
      else if (ch === "]" || ch === "}") depth--;
      else if (ch === sep && depth === 0) {
        parts.push(current);
        current = "";
        continue;
      }
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

function parseInlineScalar(token: string): YamlValue {
  const t = token.trim();
  if (t === "") throw new Error("empty scalar");
  if (t.startsWith('"')) {
    if (!t.endsWith('"') || t.length < 2) throw new Error(`unclosed double quote: ${t}`);
    return t.slice(1, -1).replace(/\\"/g, '"');
  }
  if (t.startsWith("[") || t.startsWith("{")) return parseInlineCollection(t);
  if (t.includes(": ")) throw new Error(`unexpected colon in scalar: ${t}`);
  return t;
}

function parseInlineCollection(t: string): YamlValue {
  if (t.startsWith("[")) {
    if (!t.endsWith("]")) throw new Error(`unclosed list: ${t}`);
    const inner = t.slice(1, -1).trim();
    if (inner === "") return [];
    return splitTopLevel(inner, ",").map((item) => parseInlineScalar(item));
  }
  if (!t.endsWith("}")) throw new Error(`unclosed map: ${t}`);
  const inner = t.slice(1, -1).trim();
  if (inner === "") return {};
  const out: { [key: string]: YamlValue } = {};
  for (const pair of splitTopLevel(inner, ",")) {
    const idx = pair.indexOf(":");
    if (idx < 0) throw new Error(`map entry missing colon: ${pair}`);
    const key = parseInlineScalar(pair.slice(0, idx));
    if (typeof key !== "string") throw new Error(`non-string map key: ${pair}`);
    out[key] = parseInlineScalar(pair.slice(idx + 1));
  }
  return out;
}

function splitKey(content: string): { key: string; rest: string } {
  if (content.startsWith('"')) {
    const end = content.indexOf('"', 1);
    if (end < 0) throw new Error(`unclosed quoted key: ${content}`);
    const key = content.slice(1, end).replace(/\\"/g, '"');
    const rest = content.slice(end + 1);
    if (!rest.startsWith(":")) throw new Error(`quoted key missing colon: ${content}`);
    return { key, rest: rest.slice(1) };
  }
  const idx = content.indexOf(":");
  if (idx < 0) throw new Error(`line missing colon: ${content}`);
  return { key: content.slice(0, idx).trim(), rest: content.slice(idx + 1) };
}

function parseBlock(lines: YamlLine[], start: number, indent: number): [YamlValue, number] {
  if (start >= lines.length) throw new Error("unexpected end of input");
  if (lines[start].content.startsWith("- ")) {
    const items: YamlValue[] = [];
    let i = start;
    while (i < lines.length && lines[i].indent === indent && lines[i].content.startsWith("- ")) {
      items.push(parseInlineScalar(lines[i].content.slice(2)));
      i++;
    }
    return [items, i];
  }
  const map: { [key: string]: YamlValue } = {};
  let i = start;
  while (i < lines.length && lines[i].indent === indent) {
    const { key, rest } = splitKey(lines[i].content);
    const valueText = rest.trim();
    if (valueText === "") {
      if (i + 1 < lines.length && lines[i + 1].indent > indent) {
        const [nested, next] = parseBlock(lines, i + 1, lines[i + 1].indent);
        map[key] = nested;
        i = next;
      } else {
        map[key] = "";
        i++;
      }
    } else {
      map[key] = parseInlineScalar(valueText);
      i++;
    }
  }
  return [map, i];
}

export function parseSensorYaml(
  text: string
): { ok: true; value: YamlValue } | { ok: false; error: string } {
  try {
    const rawLines = text.split(/\r?\n/);
    const lines: YamlLine[] = [];
    for (const raw of rawLines) {
      const stripped = stripComment(raw).replace(/\t/g, "  ");
      const trimmed = stripped.trim();
      if (trimmed === "") continue;
      const indent = stripped.length - stripped.trimStart().length;
      if (indent % 2 !== 0) throw new Error(`indentation not 2-space: ${raw}`);
      lines.push({ indent, content: trimmed });
    }
    if (lines.length === 0) return { ok: false, error: "empty sensor file" };
    const [value, consumed] = parseBlock(lines, 0, lines[0].indent);
    if (consumed !== lines.length) throw new Error("trailing unparsed content");
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: String((err as Error).message || err) };
  }
}

function isRecord(v: YamlValue | undefined): v is { [key: string]: YamlValue } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: YamlValue | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asBool(v: YamlValue | undefined): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

function asNumber(v: YamlValue | undefined): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return undefined;
}

function asStringList(v: YamlValue | undefined): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const item of v) {
    const s = typeof item === "string" ? item : asNumber(item) !== undefined ? String(item) : undefined;
    if (s === undefined) return undefined;
    out.push(s);
  }
  return out;
}

function asNumberList(v: YamlValue | undefined): number[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: number[] = [];
  for (const item of v) {
    const n = asNumber(item);
    if (n === undefined) return undefined;
    out.push(n);
  }
  return out;
}

const TIERS = ["ERROR", "WARNING", "INFO"];

function asTier(v: YamlValue | undefined): string | undefined {
  const s = asString(v);
  if (s === undefined) return undefined;
  const up = s.toUpperCase();
  return TIERS.includes(up) ? up : undefined;
}

function toMode(v: YamlValue | undefined): SemgrepMode | undefined {
  const s = asString(v);
  if (s === undefined) return undefined;
  const m = s.toLowerCase();
  return m === "advise" ? "advise" : m === "block" ? "block" : undefined;
}

const DEFAULT_FIELDS = { ruleId: "ruleId", path: "path", line: "line", message: "message", severity: "severity" };
const ESLINT_SEVERITY_MAP = { "2": "ERROR", "1": "WARNING" };
const ESLINT_EXIT_CODES = [0, 1];

export function normalizeSensorConfig(
  raw: YamlValue,
  file: string,
  sensorDir: string
): { ok: true; config: SensorConfig } | { ok: false; error: string } {
  try {
    if (!isRecord(raw)) return { ok: false, error: "sensor root must be a mapping" };
    const id = asString(raw.id);
    if (id === undefined || !/^[a-z0-9-]+$/.test(id)) {
      return { ok: false, error: `invalid or missing id: ${JSON.stringify(raw.id ?? null)}` };
    }
    const rawCommand = Array.isArray(raw.command) ? raw.command : undefined;
    if (rawCommand === undefined || rawCommand.length === 0) {
      return { ok: false, error: "command must be a non-empty array of strings" };
    }
    const command: string[] = [];
    for (const arg of rawCommand) {
      const s = asString(arg);
      if (s === undefined) return { ok: false, error: `command args must be strings, got: ${JSON.stringify(arg ?? null)}` };
      command.push(s);
    }
    const timeoutMs = asNumber(raw.timeoutMs);
    if (raw.timeoutMs !== undefined && (timeoutMs === undefined || timeoutMs <= 0)) {
      return { ok: false, error: `timeoutMs must be a positive number` };
    }
    const cwd = asString(raw.cwd);
    let env: Record<string, string> | undefined;
    if (raw.env !== undefined) {
      if (!isRecord(raw.env)) return { ok: false, error: "env must be a mapping" };
      env = {};
      for (const [k, v] of Object.entries(raw.env)) {
        const s = asString(v);
        if (s === undefined) return { ok: false, error: `env values must be strings: ${k}` };
        env[k] = s;
      }
    }
    let include: string[] = [];
    let exclude: string[] = [];
    let tools: string[] = ["write"];
    if (raw.triggers !== undefined) {
      if (!isRecord(raw.triggers)) return { ok: false, error: "triggers must be a mapping" };
      const inc = asStringList(raw.triggers.include);
      if (raw.triggers.include !== undefined && inc === undefined) return { ok: false, error: "triggers.include must be a list of strings" };
      include = inc ?? [];
      const exc = asStringList(raw.triggers.exclude);
      if (raw.triggers.exclude !== undefined && exc === undefined) return { ok: false, error: "triggers.exclude must be a list of strings" };
      exclude = exc ?? [];
      const tls = asStringList(raw.triggers.tools);
      if (raw.triggers.tools !== undefined && tls === undefined) return { ok: false, error: "triggers.tools must be a list of strings" };
      if (tls !== undefined) {
        for (const t of tls) {
          if (t !== "write" && t !== "edit") return { ok: false, error: `unknown trigger tool: ${t}` };
        }
        tools = tls;
      }
    }
    if (!isRecord(raw.format)) return { ok: false, error: "format must be a mapping" };
    const formatType = asString(raw.format.type);
    if (formatType !== "json" && formatType !== "regex" && formatType !== "preset:eslint-json") {
      return { ok: false, error: `unknown format.type: ${String(formatType)}` };
    }
    let findingsPath = "";
    let fields = { ...DEFAULT_FIELDS };
    let pattern: string | undefined;
    if (formatType === "json") {
      const fp = asString(raw.format.findingsPath);
      if (raw.format.findingsPath !== undefined && fp === undefined) return { ok: false, error: "format.findingsPath must be a string" };
      findingsPath = fp ?? "";
      if (raw.format.fields !== undefined) {
        if (!isRecord(raw.format.fields)) return { ok: false, error: "format.fields must be a mapping" };
        for (const key of Object.keys(DEFAULT_FIELDS) as (keyof typeof DEFAULT_FIELDS)[]) {
          const v = asString(raw.format.fields[key]);
          if (raw.format.fields[key] !== undefined && v === undefined) return { ok: false, error: `format.fields.${key} must be a string` };
          if (v !== undefined) fields[key] = v;
        }
      }
    } else if (formatType === "regex") {
      pattern = asString(raw.format.pattern);
      if (pattern === undefined) return { ok: false, error: "format.pattern is required for regex sensors" };
      try {
        new RegExp(pattern);
      } catch (err) {
        return { ok: false, error: `invalid format.pattern: ${String((err as Error).message || err)}` };
      }
    }
    let exitCodes = formatType === "preset:eslint-json" ? [...ESLINT_EXIT_CODES] : [0];
    if (raw.exitCodes !== undefined) {
      if (!isRecord(raw.exitCodes)) return { ok: false, error: "exitCodes must be a mapping" };
      const codes = asNumberList(raw.exitCodes.findings);
      if (codes === undefined) return { ok: false, error: "exitCodes.findings must be a list of numbers" };
      exitCodes = codes;
    }
    let severityMap: Record<string, string> =
      formatType === "preset:eslint-json" ? { ...ESLINT_SEVERITY_MAP } : {};
    let severityDefault = "INFO";
    if (raw.severity !== undefined) {
      if (!isRecord(raw.severity)) return { ok: false, error: "severity must be a mapping" };
      if (raw.severity.map !== undefined) {
        if (!isRecord(raw.severity.map)) return { ok: false, error: "severity.map must be a mapping" };
        for (const [k, v] of Object.entries(raw.severity.map)) {
          const tier = asTier(v);
          if (tier === undefined) return { ok: false, error: `severity.map.${k} must be ERROR, WARNING or INFO` };
          severityMap[k] = tier;
        }
      }
      if (raw.severity.default !== undefined) {
        const tier = asTier(raw.severity.default);
        if (tier === undefined) return { ok: false, error: "severity.default must be ERROR, WARNING or INFO" };
        severityDefault = tier;
      }
    }
    let defaults: SensorConfig["defaults"] = {};
    if (raw.defaults !== undefined) {
      if (!isRecord(raw.defaults)) return { ok: false, error: "defaults must be a mapping" };
      const why = asString(raw.defaults.why);
      const instead = asString(raw.defaults.instead);
      const appealable = asBool(raw.defaults.appealable);
      if (raw.defaults.why !== undefined && why === undefined) return { ok: false, error: "defaults.why must be a string" };
      if (raw.defaults.instead !== undefined && instead === undefined) return { ok: false, error: "defaults.instead must be a string" };
      if (raw.defaults.appealable !== undefined && appealable === undefined) return { ok: false, error: "defaults.appealable must be a boolean" };
      defaults = {
        ...(why !== undefined ? { why } : {}),
        ...(instead !== undefined ? { instead } : {}),
        ...(appealable !== undefined ? { appealable } : {}),
      };
    }
    let lifecycle: SensorConfig["lifecycle"] = {};
    if (raw.lifecycle !== undefined) {
      if (!isRecord(raw.lifecycle)) return { ok: false, error: "lifecycle must be a mapping" };
      const status = asString(raw.lifecycle.status);
      if (raw.lifecycle.status !== undefined && status === undefined) return { ok: false, error: "lifecycle.status must be a string" };
      const mode = toMode(raw.lifecycle.mode);
      if (raw.lifecycle.mode !== undefined && mode === undefined) return { ok: false, error: `lifecycle.mode must be block or advise: ${String(raw.lifecycle.mode)}` };
      lifecycle = {
        ...(status !== undefined ? { status: status.toLowerCase() } : {}),
        ...(mode !== undefined ? { mode } : {}),
      };
    }
    const description = asString(raw.description);
    return {
      ok: true,
      config: {
        id,
        ...(description !== undefined ? { description } : {}),
        command,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
        ...(env !== undefined ? { env } : {}),
        include,
        exclude,
        tools,
        formatType,
        findingsPath,
        fields,
        ...(pattern !== undefined ? { pattern } : {}),
        exitCodes,
        severityMap,
        severityDefault,
        defaults,
        lifecycle,
        sensorDir,
        file,
      },
    };
  } catch (err) {
    return { ok: false, error: String((err as Error).message || err) };
  }
}

function dotPath(obj: unknown, path: string): unknown {
  if (path === "") return obj;
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function toLine(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return undefined;
}

export function parseJsonFormat(
  stdout: string,
  config: SensorConfig
): { ok: true; items: RawFinding[] } | { ok: false } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false };
  }
  const target = dotPath(parsed, config.findingsPath);
  if (!Array.isArray(target)) return { ok: false };
  const items: RawFinding[] = [];
  for (const entry of target) {
    if (entry === null || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    items.push({
      ruleId: dotPath(rec, config.fields.ruleId),
      path: dotPath(rec, config.fields.path),
      line: toLine(dotPath(rec, config.fields.line)),
      message: dotPath(rec, config.fields.message),
      severity: dotPath(rec, config.fields.severity),
    });
  }
  return { ok: true, items };
}

export function parseEslintFormat(stdout: string): { ok: true; items: RawFinding[] } | { ok: false } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false };
  }
  if (!Array.isArray(parsed)) return { ok: false };
  const items: RawFinding[] = [];
  for (const fileEntry of parsed) {
    if (fileEntry === null || typeof fileEntry !== "object") continue;
    const rec = fileEntry as Record<string, unknown>;
    const filePath = rec.filePath;
    const messages = Array.isArray(rec.messages) ? rec.messages : [];
    for (const msg of messages) {
      if (msg === null || typeof msg !== "object") continue;
      const m = msg as Record<string, unknown>;
      items.push({
        ruleId: m.ruleId,
        path: filePath,
        line: toLine(m.line),
        message: m.message,
        severity: m.severity,
      });
    }
  }
  return { ok: true, items };
}

export function parseRegexFormat(
  stdout: string,
  config: SensorConfig
): { ok: true; items: RawFinding[] } | { ok: false } {
  if (config.pattern === undefined) return { ok: false };
  let re: RegExp;
  try {
    re = new RegExp(config.pattern);
  } catch {
    return { ok: false };
  }
  const items: RawFinding[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = re.exec(line);
    if (m === null || m.groups === undefined) continue;
    const g = m.groups as Record<string, unknown>;
    items.push({
      ruleId: g.ruleId,
      path: g.file,
      line: toLine(g.line),
      message: g.message,
      severity: g.severityGroup,
    });
  }
  return { ok: true, items };
}

export function mapSeverity(config: SensorConfig, raw: unknown): string {
  if (typeof raw !== "string" && typeof raw !== "number") return config.severityDefault;
  const tier = config.severityMap[String(raw)];
  return tier !== undefined ? tier : config.severityDefault;
}

function toSensorFinding(
  config: SensorConfig,
  item: RawFinding,
  resolvePath: () => string
): SensorFinding & { path: string } {
  const toolRule = typeof item.ruleId === "string" && item.ruleId !== "" ? item.ruleId : undefined;
  const message = typeof item.message === "string" && item.message !== "" ? item.message : undefined;
  const line = typeof item.line === "number" && Number.isFinite(item.line) ? item.line : undefined;
  return {
    checkId: toolRule ?? config.id,
    severity: mapSeverity(config, item.severity),
    ...(message !== undefined ? { message } : {}),
    ...(line !== undefined ? { startLine: line } : {}),
    ...(config.defaults.why ? { why: config.defaults.why } : {}),
    ...(config.defaults.instead ? { instead: config.defaults.instead } : {}),
    ...(config.defaults.appealable !== undefined ? { appealable: config.defaults.appealable } : {}),
    ...(config.lifecycle.mode !== undefined ? { mode: config.lifecycle.mode } : {}),
    ...(config.lifecycle.status !== undefined ? { status: config.lifecycle.status } : {}),
    sensorId: config.id,
    ...(toolRule !== undefined ? { toolRule } : {}),
    path: resolvePath(),
  };
}

function resolveFindingPath(
  reported: unknown,
  scratchRoot: string,
  scratchToReal: Map<string, string>,
  writtenReal: string
): string {
  if (typeof reported !== "string" || reported === "") return writtenReal;
  const abs = norm(resolve(scratchRoot, reported.replace(/\\/g, "/")));
  const mapped = scratchToReal.get(abs);
  return mapped ?? writtenReal;
}

function safeJsonParse(text: string): { ok: true; value: YamlValue } | { ok: false; error: string } {
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: "JSON sensor root must be an object" };
    }
    return { ok: true, value: value as { [key: string]: YamlValue } };
  } catch (err) {
    return { ok: false, error: String((err as Error).message || err) };
  }
}

function hasTopLevelId(text: string): boolean {
  for (const line of text.split(/\r?\n/)) {
    if (/^id\s*:/.test(line)) return true;
  }
  return false;
}

export function loadSensors(config: EngineConfig): {
  sensors: SensorConfig[];
  errors: SensorConfigError[];
} {
  const dir = config.sensorsDir ?? join(config.protectedRoot, SENSORS_SUBDIR);
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => /\.(ya?ml|json)$/i.test(f));
  } catch {
    return { sensors: [], errors: [] };
  }
  names.sort();
  const sensors: SensorConfig[] = [];
  const errors: SensorConfigError[] = [];
  for (const name of names) {
    const file = join(dir, name);
    try {
      const text = readFileSync(file, "utf8");
      const isJson = /\.json$/i.test(name);
      const parsed = isJson ? safeJsonParse(text) : parseSensorYaml(text);
      if (!parsed.ok) {
        if (!isJson && !hasTopLevelId(text)) continue;
        errors.push({ file, error: parsed.error });
        continue;
      }
      const normalized = normalizeSensorConfig(parsed.value, file, dirname(file));
      if (!normalized.ok) {
        errors.push({ file, error: normalized.error });
        continue;
      }
      sensors.push(normalized.config);
    } catch (err) {
      errors.push({ file, error: String((err as Error).message || err) });
    }
  }
  return { sensors, errors };
}

export function templatePlaceholders(s: string, ctx: Record<string, string>): string {
  return s.replace(/\{(file|relPath|fileName|root|sensorDir|workdir)\}/g, (_, k: string) => ctx[k]);
}

function resolveBin(argv0: string): string | null {
  if (/[/\\]/.test(argv0) || /^[a-zA-Z]:/.test(argv0)) return existsSync(argv0) ? argv0 : null;
  const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";");
  for (const dir of (process.env.PATH ?? "").split(";")) {
    const d = dir.trim();
    if (d === "") continue;
    if (existsSync(join(d, argv0))) return argv0;
    for (const ext of exts) {
      if (existsSync(join(d, argv0 + ext.toLowerCase()))) return argv0;
    }
  }
  return null;
}

function execFileP(
  bin: string,
  args: string[],
  opts: { timeout: number; cwd: string; env: NodeJS.ProcessEnv }
): Promise<{ stdout: string; exitCode: number | null; spawnError?: Error; killed?: boolean }> {
  return new Promise((resolveP) => {
    const handle = (err: Error | null, out: string) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
      if (e === null || e === undefined) {
        resolveP({ stdout: out ?? "", exitCode: 0 });
        return;
      }
      if (typeof e.code === "number") {
        resolveP({ stdout: out ?? "", exitCode: e.code, spawnError: e, killed: e.killed });
        return;
      }
      resolveP({ stdout: out ?? "", exitCode: null, spawnError: e, killed: e.killed });
    };
    try {
      execFile(
        bin,
        args,
        {
          timeout: opts.timeout,
          maxBuffer: MAX_BUFFER,
          windowsHide: true,
          cwd: opts.cwd,
          env: opts.env,
        },
        handle
      );
    } catch (err) {
      resolveP({ stdout: "", exitCode: null, spawnError: err as Error, killed: true });
    }
  });
}

function matchSensorTrigger(
  config: SensorConfig,
  call: ToolCallDescription
): { relNorm: string; realPath: string } | null {
  for (const p of call.paths) {
    const realPath = norm(resolve(call.workdir, p.replace(/\\/g, "/")));
    const rel = relative(call.workdir, resolve(call.workdir, p.replace(/\\/g, "/")));
    const relNorm = rel.split(/[\\/]/).join("/");
    if (config.exclude.some((g) => globMatch(g, relNorm))) continue;
    if (config.include.length > 0 && !config.include.some((g) => globMatch(g, relNorm))) continue;
    return { relNorm, realPath };
  }
  return null;
}

interface ParsedRun {
  items: RawFinding[];
  unparseable: boolean;
}

function parseRunOutput(stdout: string, config: SensorConfig): ParsedRun {
  if (config.formatType === "json") {
    const parsed = parseJsonFormat(stdout, config);
    return parsed.ok ? { items: parsed.items, unparseable: false } : { items: [], unparseable: true };
  }
  if (config.formatType === "preset:eslint-json") {
    const parsed = parseEslintFormat(stdout);
    return parsed.ok ? { items: parsed.items, unparseable: false } : { items: [], unparseable: true };
  }
  const parsed = parseRegexFormat(stdout, config);
  return parsed.ok ? { items: parsed.items, unparseable: false } : { items: [], unparseable: true };
}

async function rmScratch(scratchRoot: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      rmSync(scratchRoot, { recursive: true, force: true });
      break;
    } catch {
      if (attempt < 2) await new Promise((r) => setTimeout(r, 50));
    }
  }
  const slugDir = dirname(scratchRoot);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (!existsSync(slugDir)) break;
      if (readdirSync(slugDir).length === 0) {
        rmdirSync(slugDir);
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    } catch {
      if (attempt < 2) await new Promise((r) => setTimeout(r, 50));
    }
  }
}

export async function runSensors(
  call: ToolCallDescription,
  config: EngineConfig
): Promise<SensorGateResult> {
  const started = Date.now();
  const result: SensorGateResult = { entries: [], configErrors: [], findings: [] };
  try {
    const { sensors, errors } = loadSensors(config);
    result.configErrors = errors;
    if (sensors.length === 0 && errors.length === 0) return result;
    const slug = String(call.workdir).replace(/[^a-zA-Z0-9._-]/g, "_");
    for (const sensor of sensors.slice(0, MAX_SENSORS)) {
      const startedSensor = Date.now();
      const trigger = matchSensorTrigger(sensor, call);
      if (trigger === null) continue;
      result.scopePath = trigger.realPath;
      const text = call.tool === "write" ? call.content : call.newText;
      if (!sensor.tools.includes(call.tool) || typeof text !== "string" || text === "") {
        result.entries.push({
          sensorId: sensor.id,
          ran: false,
          reason: "no-candidate",
          findings: [],
          durationMs: Date.now() - startedSensor,
        });
        continue;
      }
      const scratchRoot = join(tmpdir(), "opencode", "bp-sensors", slug, sensor.id);
      const scratchFile = join(scratchRoot, trigger.relNorm);
      try {
        mkdirSync(dirname(scratchFile), { recursive: true });
        writeFileSync(scratchFile, text, "utf8");
        const scratchToReal = new Map<string, string>([[norm(scratchFile), trigger.realPath]]);
        const writtenReal = trigger.realPath;
        const ctx: Record<string, string> = {
          file: scratchFile,
          relPath: trigger.relNorm,
          fileName: basename(trigger.relNorm),
          root: scratchRoot,
          sensorDir: sensor.sensorDir,
          workdir: call.workdir,
        };
        const argv = sensor.command.map((a) => templatePlaceholders(a, ctx));
        const bin = resolveBin(argv[0]);
        if (bin === null) {
          result.entries.push({
            sensorId: sensor.id,
            ran: false,
            reason: "no-bin",
            findings: [],
            durationMs: Date.now() - startedSensor,
          });
          continue;
        }
        const run = await execFileP(bin, argv.slice(1), {
          timeout: sensor.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          cwd: sensor.cwd ? templatePlaceholders(sensor.cwd, ctx) : call.workdir,
          env: { ...process.env, ...(sensor.env ?? {}) },
        });
        let entries: (SensorFinding & { path: string })[] = [];
        if (run.exitCode === null) {
          result.entries.push({
            sensorId: sensor.id,
            ran: true,
            reason: "timeout",
            findings: [],
            durationMs: Date.now() - startedSensor,
          });
          continue;
        }
        if (!sensor.exitCodes.includes(run.exitCode)) {
          result.entries.push({
            sensorId: sensor.id,
            ran: true,
            reason: `exit:${run.exitCode}`,
            findings: [],
            durationMs: Date.now() - startedSensor,
          });
          continue;
        }
        const parsed = parseRunOutput(run.stdout, sensor);
        if (parsed.unparseable) {
          result.entries.push({
            sensorId: sensor.id,
            ran: true,
            reason: "unparseable",
            findings: [],
            durationMs: Date.now() - startedSensor,
          });
          continue;
        }
        entries = parsed.items.map((item) =>
          toSensorFinding(sensor, item, () =>
            resolveFindingPath(item.path, scratchRoot, scratchToReal, writtenReal)
          )
        );
        result.entries.push({
          sensorId: sensor.id,
          ran: true,
          findings: entries,
          durationMs: Date.now() - startedSensor,
        });
        result.findings.push(...entries);
      } catch (err) {
        result.entries.push({
          sensorId: sensor.id,
          ran: true,
          reason: String((err as Error).message || err),
          findings: [],
          durationMs: Date.now() - startedSensor,
        });
      } finally {
        await rmScratch(scratchRoot);
      }
    }
    for (const sensor of sensors.slice(MAX_SENSORS)) {
      result.entries.push({
        sensorId: sensor.id,
        ran: false,
        reason: "sensor-cap",
        findings: [],
        durationMs: 0,
      });
    }
    return result;
  } catch (err) {
    result.entries.push({
      sensorId: "unknown",
      ran: true,
      reason: String((err as Error).message || err),
      findings: [],
      durationMs: Date.now() - started,
    });
    return result;
  }
}

export async function runSensorsRescan(
  files: string[],
  config: EngineConfig
): Promise<SensorRescanResult> {
  const started = Date.now();
  const scratchRootBase = join(
    tmpdir(),
    "opencode",
    "bp-sensors",
    String(config.protectedRoot).replace(/[^a-zA-Z0-9._-]/g, "_")
  );
  const configErrors: SensorConfigError[] = [];
  const fail = (reason: string): SensorRescanResult => ({
    ran: false,
    reason,
    findings: [],
    durationMs: Date.now() - started,
    configErrors,
  });
  try {
    if (files.length === 0) return fail("no-files");
    const { sensors, errors } = loadSensors(config);
    configErrors.push(...errors);
    const rootSensors = sensors.filter((s) => s.command.some((a) => a.includes("{root}")));
    if (rootSensors.length === 0) return fail("rescan-unsupported");
    const findings: (SensorFinding & { path: string })[] = [];
    for (const sensor of rootSensors) {
      const scratchRoot = join(scratchRootBase, sensor.id);
      try {
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
        if (laidOut === 0) continue;
        const ctx: Record<string, string> = {
          file: "",
          relPath: "",
          fileName: "",
          root: scratchRoot,
          sensorDir: sensor.sensorDir,
          workdir: config.protectedRoot,
        };
        const argv = sensor.command.map((a) => templatePlaceholders(a, ctx));
        const bin = resolveBin(argv[0]);
        if (bin === null) continue;
        const run = await execFileP(bin, argv.slice(1), {
          timeout: sensor.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          cwd: sensor.cwd ? templatePlaceholders(sensor.cwd, ctx) : config.protectedRoot,
          env: { ...process.env, ...(sensor.env ?? {}) },
        });
        if (run.exitCode === null || !sensor.exitCodes.includes(run.exitCode)) continue;
        const parsed = parseRunOutput(run.stdout, sensor);
        if (parsed.unparseable) continue;
        for (const item of parsed.items) {
          const reported =
            typeof item.path === "string" && item.path !== "" ? item.path : undefined;
          const real = reported
            ? scratchToReal.get(norm(resolve(scratchRoot, reported.replace(/\\/g, "/"))))
            : undefined;
          if (real === undefined) continue;
          findings.push(
            toSensorFinding(sensor, item, () => real)
          );
        }
      } catch {
        continue;
      } finally {
        await rmScratch(scratchRoot);
      }
    }
    return { ran: true, findings, durationMs: Date.now() - started, configErrors };
  } catch (err) {
    return {
      ran: true,
      reason: String((err as Error).message || err),
      findings: [],
      durationMs: Date.now() - started,
      configErrors,
    };
  }
}
