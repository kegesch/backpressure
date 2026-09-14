import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { runTier0Checkers } from "./tier0-checkers.ts";

export const DEFAULT_TIER = 2;
export const APPEAL_VALIDATOR_NAME = "appeal-system";
export const NON_APPEALABLE_VALIDATORS = ["no-dangerous-git"];

export interface CommitContext {
  diff: string;
  files: string[];
  message: string;
  command: string;
  cwd: string;
}

export function isCommitCommand(command: string): boolean {
  return /\bgit\s+commit\b/.test(command);
}

export function extractCdTarget(command: string): string | null {
  const match = command.match(/^cd\s+(\S+)/);
  return match ? match[1] : null;
}

export function extractCommitMessage(command: string): string {
  const match = command.match(/-m\s+["']([^"']+)["']/);
  return match ? match[1] : "";
}

export function extractAppeal(message: string): string | null {
  const match = message.match(/\[appeal:\s*([^\]]+)\]/);
  return match ? match[1].trim() : null;
}

export function getCommitContext(cwd: string, command: string): CommitContext {
  const gitCwd = resolve(cwd, extractCdTarget(command) ?? ".");
  const diff = execFileSync("git", ["diff", "--cached"], {
    cwd: gitCwd,
    encoding: "utf8",
  });
  const nameOnly = execFileSync("git", ["diff", "--cached", "--name-only"], {
    cwd: gitCwd,
    encoding: "utf8",
  });
  const files = nameOnly.trim().split("\n").filter(Boolean);
  const message = extractCommitMessage(command);
  return { diff, files, message, command, cwd: gitCwd };
}

export interface Validator {
  name: string;
  description: string;
  enabled: boolean;
  tier: number;
  content: string;
  path: string;
}

function resolveTier(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (Number.isInteger(n) && n >= 0 && n <= 2) return n;
  return DEFAULT_TIER;
}

interface ParsedFrontmatter {
  data: Record<string, unknown>;
  content: string;
}

function parseFrontmatter(fileContent: string): ParsedFrontmatter {
  if (!fileContent.startsWith("---")) {
    return { data: {}, content: fileContent.trim() };
  }
  const end = fileContent.indexOf("\n---", 3);
  if (end < 0) {
    return { data: {}, content: fileContent.slice(3).trim() };
  }
  const block = fileContent.slice(3, end);
  const content = fileContent.slice(end + 4).trim();
  const data: Record<string, unknown> = {};
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || !line.includes(":")) continue;
    const idx = line.indexOf(":");
    const key = line.slice(0, idx).trim();
    const rawVal = line.slice(idx + 1).trim();
    let val: unknown = rawVal;
    if (rawVal === "true") val = true;
    else if (rawVal === "false") val = false;
    else if (/^-?\d+$/.test(rawVal)) val = Number(rawVal);
    data[key] = val;
  }
  return { data, content };
}

export function loadValidators(
  dirs: string[],
  overrides?: Record<string, { enabled: boolean }>,
): Validator[] {
  const validators: Validator[] = [];

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir).sort();
    for (const file of files) {
      if (!file.endsWith(".md")) continue;

      const filePath = join(dir, file);
      const fileContent = readFileSync(filePath, "utf8");
      const { data, content } = parseFrontmatter(fileContent);

      const name = (data.name as string) ?? file.slice(0, -3);
      const override = overrides?.[name];
      const enabled = override !== undefined ? override.enabled : data.enabled !== false;

      if (!enabled) continue;

      validators.push({
        name,
        description: (data.description as string) ?? "",
        enabled: true,
        tier: resolveTier(data.tier),
        content,
        path: filePath,
      });
    }
  }

  return validators;
}

export interface ValidatorResult {
  decision: "ACK" | "NACK";
  reason?: string;
}

const INVALID_RESPONSE: ValidatorResult = {
  decision: "NACK",
  reason: "validator returned invalid response (no ACK decision)",
};

export function parseValidatorOutput(stdout: string): ValidatorResult {
  try {
    const parsed = JSON.parse(stdout);
    if (parsed.decision === "ACK" || parsed.decision === "NACK") {
      return { decision: parsed.decision, reason: parsed.reason };
    }
  } catch {
    // Not pure JSON — try to extract JSON from the response
  }

  const jsonMatch = stdout.match(
    /\{[\s\S]*?"decision"\s*:\s*"(ACK|NACK)"[\s\S]*?\}/,
  );
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.decision === "ACK" || parsed.decision === "NACK") {
        return { decision: parsed.decision, reason: parsed.reason };
      }
    } catch {
      // fall through
    }
  }

  return INVALID_RESPONSE;
}

function buildPrompt(validator: Validator, context: CommitContext): string {
  return `<diff>
${context.diff}
</diff>

<commit-message>
${context.message}
</commit-message>

<files>
${context.files.join("\n")}
</files>

${validator.content}`;
}

function buildAppealPrompt(
  appealValidator: Validator,
  context: CommitContext,
  results: CommitValidationResult[],
  appeal: string,
): string {
  const resultsText = results
    .map((r) => `${r.validator}: ${r.decision}${r.reason ? ` - ${r.reason}` : ""}`)
    .join("\n");

  return `<diff>
${context.diff}
</diff>

<commit-message>
${context.message}
</commit-message>

<files>
${context.files.join("\n")}
</files>

<validator-results>
${resultsText}
</validator-results>

<appeal>
${appeal}
</appeal>

${appealValidator.content}`;
}

export interface CommitValidationResult {
  validator: string;
  decision: "ACK" | "NACK";
  reason?: string;
  appealable: boolean;
}

export type CommitValidatorLogger = (
  event: "spawn" | "complete" | "error" | "skip",
  name: string,
  detail?: string,
) => void;

function stripValidatorBoilerplate(content: string): string {
  return content
    .replace(/^You are a commit validator\.[^\n]*\n*/m, "")
    .replace(
      /\n*Valid responses:\n\{"decision":"ACK"\}\n\{"decision":"NACK","reason":"[^"]*"\}\n*/m,
      "",
    )
    .replace(/\n*RESPOND WITH JSON ONLY[^\n]*/m, "")
    .trim();
}

function buildBatchedPrompt(validators: Validator[], context: CommitContext): string {
  const rulesSection = validators
    .map(
      (v) =>
        `<validator id="${v.name}">
${stripValidatorBoilerplate(v.content)}
</validator>`,
    )
    .join("\n\n");

  return `You are a commit validator evaluating a commit against multiple rule sets. Respond with a JSON array — one entry per validator with its id, decision (ACK/NACK), and reason if NACK.

<diff>
${context.diff}
</diff>

<commit-message>
${context.message}
</commit-message>

<files>
${context.files.join("\n")}
</files>

${rulesSection}

Respond with ONLY a JSON array:
[{"id":"<validator-id>","decision":"ACK"},{"id":"<validator-id>","decision":"NACK","reason":"one sentence"}]`;
}

function chunkArray<T>(arr: T[], count: number): T[][] {
  const chunks: T[][] = [];
  const size = Math.ceil(arr.length / count);
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function extractJsonArray(raw: string): unknown[] | null {
  const direct = safeJsonParse(raw);
  if (Array.isArray(direct)) return direct;

  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    const parsed = safeJsonParse(fenceMatch[1]);
    if (Array.isArray(parsed)) return parsed;
  }

  const bracketMatch = raw.match(/\[[\s\S]*\]/);
  if (bracketMatch) {
    const parsed = safeJsonParse(bracketMatch[0]);
    if (Array.isArray(parsed)) return parsed;
  }

  return null;
}

function isValidDecision(value: unknown): value is "ACK" | "NACK" {
  return value === "ACK" || value === "NACK";
}

function findEntryByName(
  arr: unknown[],
  name: string,
): Record<string, unknown> | undefined {
  for (const item of arr) {
    if (typeof item === "object" && item !== null) {
      const obj = item as Record<string, unknown>;
      if (obj.id === name || obj.validator === name) return obj;
    }
  }
  return undefined;
}

export function parseBatchedOutput(
  stdout: string,
  validatorNames: string[],
): { validator: string; decision: "ACK" | "NACK"; reason?: string }[] {
  const parsed = extractJsonArray(stdout);

  if (!parsed) {
    const nack: "NACK" = "NACK";
    return validatorNames.map((name) => ({
      validator: name,
      decision: nack,
      reason: "batched validator returned unparseable response",
    }));
  }

  const results: {
    validator: string;
    decision: "ACK" | "NACK";
    reason?: string;
  }[] = [];
  for (const name of validatorNames) {
    const entry = findEntryByName(parsed, name);
    if (!entry || !isValidDecision(entry.decision)) {
      results.push({
        validator: name,
        decision: "NACK",
        reason: "validator missing or invalid in batched response",
      });
    } else {
      const result: {
        validator: string;
        decision: "ACK" | "NACK";
        reason?: string;
      } = {
        validator: name,
        decision: entry.decision,
      };
      if (typeof entry.reason === "string") {
        result.reason = entry.reason;
      }
      results.push(result);
    }
  }
  return results;
}

export interface TierModelRef {
  providerID: string;
  modelID: string;
}

export type CommitExecutor = (prompt: string, model?: TierModelRef) => Promise<string>;

export async function runValidator(
  validator: Validator,
  context: CommitContext,
  executor: CommitExecutor,
): Promise<ValidatorResult> {
  const prompt = buildPrompt(validator, context);

  const first = await executor(prompt);
  const firstResult = parseValidatorOutput(first);
  if (firstResult !== INVALID_RESPONSE) {
    return firstResult;
  }

  const second = await executor(prompt);
  return parseValidatorOutput(second);
}

export async function runAppealValidator(
  appealValidator: Validator,
  context: CommitContext,
  results: CommitValidationResult[],
  appeal: string,
  executor: CommitExecutor,
): Promise<ValidatorResult> {
  const prompt = buildAppealPrompt(appealValidator, context, results, appeal);
  const response = await executor(prompt);
  return parseValidatorOutput(response);
}

function tierFor(v: Validator): 0 | 1 | 2 {
  if (v.tier === 0) return 0;
  if (v.tier === 1) return 1;
  return 2;
}

function runTier0Chunk(
  validators: Validator[],
  context: CommitContext,
  onLog?: CommitValidatorLogger,
): CommitValidationResult[] {
  if (validators.length === 0) return [];
  const names = validators.map((v) => v.name);
  for (const name of names) {
    onLog?.("spawn", name, "tier-0 deterministic");
  }
  const results = runTier0Checkers(names, context);
  return results.map((r) => {
    onLog?.(
      "complete",
      r.validator,
      `${r.decision}${r.reason ? `: ${r.reason}` : ""}`,
    );
    return {
      validator: r.validator,
      decision: r.decision,
      reason: r.reason,
      appealable: !NON_APPEALABLE_VALIDATORS.includes(r.validator),
    };
  });
}

async function runTieredChunk(
  validators: Validator[],
  context: CommitContext,
  onLog: CommitValidatorLogger | undefined,
  batchCount: number,
  model: TierModelRef | undefined,
  tier: 1 | 2,
  executor: CommitExecutor | undefined,
): Promise<CommitValidationResult[]> {
  if (validators.length === 0) return [];

  if (executor === undefined) {
    for (const v of validators) {
      onLog?.("skip", v.name, "no executor");
    }
    return [];
  }

  const chunks = chunkArray(validators, batchCount);

  const pending = chunks.map(async (chunk, chunkIndex) => {
    const names = chunk.map((v) => v.name);
    onLog?.(
      "spawn",
      `tier${tier}-batch-${chunkIndex}`,
      `validators: ${names.join(", ")}`,
    );

    try {
      const prompt = buildBatchedPrompt(chunk, context);
      const response = await executor(prompt, model);
      const batchResults = parseBatchedOutput(response, names);

      return batchResults.map((br): CommitValidationResult => {
        onLog?.(
          "complete",
          br.validator,
          `${br.decision}${br.reason ? `: ${br.reason}` : ""}`,
        );
        return {
          validator: br.validator,
          decision: br.decision,
          reason: br.reason,
          appealable: !NON_APPEALABLE_VALIDATORS.includes(br.validator),
        };
      });
    } catch (err) {
      onLog?.("error", `tier${tier}-batch-${chunkIndex}`, String(err));
      return chunk.map((v) => ({
        validator: v.name,
        decision: "NACK" as const,
        reason: `validator crashed: ${String(err)}`,
        appealable: false,
      }));
    }
  });

  const batchResults = await Promise.all(pending);
  return batchResults.flat();
}

export interface ValidateCommitOptions {
  executor?: CommitExecutor;
  batchCount?: number;
  tierModels?: { tier1?: TierModelRef; tier2?: TierModelRef };
  onLog?: CommitValidatorLogger;
}

export async function validateCommit(
  validators: Validator[],
  context: CommitContext,
  options: ValidateCommitOptions = {},
): Promise<CommitValidationResult[]> {
  const batchCount = options.batchCount ?? 3;
  const tierModels = options.tierModels ?? {};
  const onLog = options.onLog;
  const executor = options.executor;

  const tier0 = validators.filter((v) => tierFor(v) === 0);
  const tier1 = validators.filter((v) => tierFor(v) === 1);
  const tier2 = validators.filter((v) => tierFor(v) === 2);

  const tier0Results = runTier0Chunk(tier0, context, onLog);
  const tier1Results = runTieredChunk(
    tier1,
    context,
    onLog,
    batchCount,
    tierModels.tier1,
    1,
    executor,
  );
  const tier2Results = runTieredChunk(
    tier2,
    context,
    onLog,
    batchCount,
    tierModels.tier2,
    2,
    executor,
  );

  const [t1, t2] = await Promise.all([tier1Results, tier2Results]);
  return [...tier0Results, ...t1, ...t2];
}

export function formatBlockMessage(results: CommitValidationResult[]): string {
  const nacks = results.filter((r) => r.decision === "NACK");
  const lines: string[] = [];

  for (const nack of nacks) {
    lines.push(`${nack.validator}: ${nack.reason}`);
  }

  const hasNonAppealable = nacks.some((r) => !r.appealable);
  const hasAppealable = nacks.some((r) => r.appealable);

  if (hasNonAppealable) {
    lines.push("");
    lines.push("This violation cannot be appealed.");
  }

  if (hasAppealable) {
    lines.push("");
    lines.push("To appeal, add [appeal: your justification] to your commit message.");
  }

  return lines.join("\n");
}

export type CommitMode = "strict" | "warn" | "off";

export interface CommitValidatorState {
  validateCommit: { mode: CommitMode; batchCount: number };
  models: { tier1: TierModelRef | null; tier2: TierModelRef | null };
  overrides: { validators: Record<string, { enabled: boolean }> };
}

export const DEFAULT_VALIDATOR_STATE: CommitValidatorState = {
  validateCommit: { mode: "strict", batchCount: 3 },
  models: { tier1: null, tier2: null },
  overrides: { validators: {} },
};

function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined || patch === null) return base;
  if (typeof patch !== "object" || Array.isArray(patch)) return patch as T;
  const baseObj = base as Record<string, unknown>;
  const patchObj = patch as Record<string, unknown>;
  const out: Record<string, unknown> = { ...baseObj };
  for (const key of Object.keys(patchObj)) {
    const b = baseObj[key];
    const p = patchObj[key];
    if (b !== undefined && typeof b === "object" && !Array.isArray(b) && typeof p === "object" && !Array.isArray(p)) {
      out[key] = deepMerge(b, p);
    } else {
      out[key] = p;
    }
  }
  return out as T;
}

export function readValidatorState(stateFile: string): CommitValidatorState {
  let raw: string;
  try {
    raw = readFileSync(stateFile, "utf8");
  } catch {
    return structuredClone(DEFAULT_VALIDATOR_STATE);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return structuredClone(DEFAULT_VALIDATOR_STATE);
  }

  if (typeof parsed !== "object" || parsed === null) {
    return structuredClone(DEFAULT_VALIDATOR_STATE);
  }

  return deepMerge(structuredClone(DEFAULT_VALIDATOR_STATE), parsed);
}