import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import {
  compareFindings,
  evaluate,
  inScopePath,
  partitionSemgrepFindings,
  type EngineVerdict,
  type SensorFinding,
  type ToolCallDescription,
} from "../../engine/core.ts";
import { runSemgrepGate, type SemgrepRunResult } from "../../engine/semgrep.ts";
import { runSensors, type SensorGateResult } from "../../engine/sensors.ts";
import { collectAdvisories, noteScanScope } from "../../engine/advisories.ts";

const denylistProbe: Plugin = async (input: PluginInput) => {
  const root = input.directory || input.worktree;
  const logDir = join(root, ".backpressure");
  const logFile = join(logDir, "hook-log.jsonl");
  mkdirSync(logDir, { recursive: true });

  const firstString = (
    obj: Record<string, unknown>,
    keys: readonly string[]
  ): string | undefined => {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === "string") return v;
    }
    return undefined;
  };

  const log = (type: string, properties: Record<string, unknown>) => {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      type,
      properties,
    });
    appendFileSync(logFile, line + "\n", "utf8");
  };

  return {
    "tool.execute.before": async (input, output) => {
      const tool = input.tool;
      const sessionID = input.sessionID;
      const callID = input.callID ?? (input as any).call_id;
      const args = output?.args ?? (input as any)?.args ?? {};

      let verdict: EngineVerdict | null = null;
      let semgrepRun: SemgrepRunResult | null = null;
      let sensorRun: SensorGateResult | null = null;
      let adviseScopePath: string | undefined;
      try {
        const paths = (["filePath", "file_path", "path"] as const)
          .map((k) => args?.[k])
          .filter((v) => typeof v === "string");
        const command = typeof args?.command === "string" ? args.command : undefined;
        const content = typeof args?.content === "string" ? args.content : undefined;
        const newText = firstString(args, ["newText", "new_string", "newStr", "newString"]) ?? undefined;
        const call: ToolCallDescription = { tool, paths, command, workdir: root, content, newText };
        const rulesDir = process.env.BACKPRESSURE_RULES_DIR || undefined;
        const qualityRoots = (process.env.BACKPRESSURE_QUALITY_ROOTS ?? "engine")
          .split(";")
          .map((r) => r.trim())
          .filter((r) => r !== "")
          .map((r) => join(root, r).replace(/\\/g, "/"));
        const config = {
          protectedRoot: root,
          qualityRoots,
          rulesDir,
          sensorsDir: process.env.BACKPRESSURE_SENSORS_DIR || undefined,
        };
        if (
          (tool === "write" || tool === "edit") &&
          (content !== undefined || newText !== undefined)
        ) {
          if (inScopePath(call, config) !== null) {
            semgrepRun = await runSemgrepGate(call, config);
            call.semgrepFindings = semgrepRun.findings;
          }
          sensorRun = await runSensors(call, config);
          call.sensorFindings = sensorRun.findings;
        }
        verdict = evaluate(call, config);
        adviseScopePath = inScopePath(call, config) ?? undefined;
      } catch (err) {
        try {
          log("probe.denylist.error", {
            sessionID,
            callID,
            tool,
            error: String(err),
          });
        } catch {
        }
        return;
      }

      try {
        const orderedKeys = ["filePath", "file_path", "path", "command"] as const;
        const parts: string[] = [];
        const remaining: Record<string, unknown> = {};
        for (const k of Object.keys(args ?? {})) {
          if ((orderedKeys as readonly string[]).includes(k) && typeof args[k] === "string") {
            parts.push(`${k}=${String(args[k]).slice(0, 200)}`);
          } else {
            remaining[k] = args[k];
          }
        }
        const hasRemaining = Object.keys(remaining).length > 0;
        const restStr = hasRemaining ? `rest=${JSON.stringify(remaining).slice(0, 200)}` : "";
        const argsPreview = [parts.join(" | "), restStr].filter(Boolean).join(" | ");
        const checkProps: Record<string, unknown> = { sessionID, callID, tool, argsPreview };
        if (verdict?.decision === "block") checkProps.rule = verdict.rule;
        log("probe.denylist.check", checkProps);
      } catch {
      }

      if (semgrepRun !== null) {
        try {
          const props: Record<string, unknown> = {
            sessionID,
            callID,
            ran: semgrepRun.ran,
            findings: semgrepRun.findings.length,
            durationMs: semgrepRun.durationMs,
          };
          if (semgrepRun.reason !== undefined) props.reason = semgrepRun.reason;
          if (semgrepRun.errors !== undefined) props.errors = semgrepRun.errors;
          log("probe.semgrep.run", props);
        } catch {
        }
      }

      if (sensorRun !== null) {
        try {
          for (const configError of sensorRun.configErrors) {
            log("probe.sensor.config", {
              sessionID,
              callID,
              file: configError.file,
              error: configError.error,
            });
          }
          for (const entry of sensorRun.entries) {
            const props: Record<string, unknown> = {
              sessionID,
              callID,
              sensorId: entry.sensorId,
              ran: entry.ran,
              findings: entry.findings.length,
              durationMs: entry.durationMs,
            };
            if (entry.reason !== undefined) props.reason = entry.reason;
            log("probe.sensor.run", props);
          }
        } catch {
        }
      }

      if (verdict?.decision === "allow" && (semgrepRun !== null || sensorRun !== null)) {
        try {
          const scopePath = adviseScopePath ?? sensorRun?.scopePath ?? "";
          if (scopePath !== "") noteScanScope(sessionID, scopePath);
          const semgrepAdvise =
            semgrepRun !== null ? partitionSemgrepFindings(semgrepRun.findings).advise : [];
          const sensorAdvise =
            sensorRun !== null ? partitionSemgrepFindings(sensorRun.findings).advise : [];
          const advise = [...semgrepAdvise, ...sensorAdvise];
          if (advise.length > 0) {
            const stored = collectAdvisories(
              sessionID,
              advise.map((f) => {
                const own = (f as { path?: unknown }).path;
                const p = typeof own === "string" && own !== "" ? own : scopePath;
                return { ...f, path: p };
              })
            );
            if (stored > 0) {
              log("probe.advise.collect", {
                sessionID,
                callID,
                findings: advise.length,
                stored,
                rules: advise.map((f) => f.checkId),
              });
            }
          }
        } catch {
        }
      }

      if (verdict?.decision === "block") {
        try {
          const sensorPicked =
            sensorRun !== null
              ? ([...partitionSemgrepFindings(sensorRun.findings).block].sort(compareFindings)[0] as
                  | SensorFinding
                  | undefined)
              : undefined;
          if (
            verdict.rule === "tool-path" ||
            verdict.rule === "shell-write" ||
            verdict.rule === "semgrep" ||
            verdict.rule === "sensor"
          ) {
            const blockedProps: Record<string, unknown> = {
              sessionID,
              callID,
              tool,
              path: verdict.detail,
              reason: verdict.reason,
              rule: verdict.rule,
              matchedIntent: verdict.matchedIntent,
              verdict: "block",
              appealable: verdict.appealable,
              msgVersion: verdict.verdictVersion,
            };
            if (verdict.modeConflict === true) blockedProps.modeConflict = true;
            if (verdict.rule === "sensor" && sensorPicked !== undefined) {
              blockedProps.sensorId = sensorPicked.sensorId;
              if (sensorPicked.toolRule !== undefined && sensorPicked.toolRule !== sensorPicked.checkId) {
                blockedProps.toolRule = sensorPicked.toolRule;
              }
              if (typeof sensorPicked.startLine === "number") {
                blockedProps.line = sensorPicked.startLine;
              }
            }
            log("probe.denylist.blocked", blockedProps);
          } else {
            log("probe.denylist.blocked", {
              sessionID,
              callID,
              tool,
              rule: verdict.rule,
              command: verdict.detail,
              reason: verdict.reason,
              matchedIntent: verdict.matchedIntent,
              verdict: "block",
              appealable: verdict.appealable,
              msgVersion: verdict.verdictVersion,
            });
          }
        } catch {
        }
        throw new Error(verdict.message ?? "BACKPRESSURE VERDICT: BLOCK");
      }
    },
  };
};

export default denylistProbe;
