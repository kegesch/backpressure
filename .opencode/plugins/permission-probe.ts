import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin, PluginInput } from "@opencode-ai/plugin";

const permissionProbe: Plugin = async (input: PluginInput) => {
  const root = input.directory || input.worktree;
  const logDir = join(root, ".backpressure");
  const logFile = join(logDir, "hook-log.jsonl");
  mkdirSync(logDir, { recursive: true });

  const log = (type: string, properties: Record<string, unknown>) => {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      type,
      properties,
    });
    appendFileSync(logFile, line + "\n", "utf8");
  };

  return {
    "permission.ask": async (input, output) => {
      try {
        log("probe.permission.check", {
          id: input.id,
          type: input.type,
          pattern: input.pattern,
          sessionID: input.sessionID,
          messageID: input.messageID,
          callID: input.callID,
          title: input.title,
          metadata: JSON.stringify(input.metadata ?? {}).slice(0, 300),
          statusIn: output?.status,
        });
      } catch (err) {
        try {
          log("probe.permission.error", {
            sessionID: input.sessionID,
            error: String(err),
          });
        } catch {
        }
      }
    },
    event: async ({ event }) => {
      if (!event.type.startsWith("permission.")) return;
      try {
        log("probe.permission.bus", {
          type: event.type,
          properties: JSON.stringify(event.properties).slice(0, 300),
        });
      } catch {
      }
    },
  };
};

export default permissionProbe;
