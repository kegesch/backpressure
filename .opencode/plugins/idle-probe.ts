import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin, PluginInput } from "@opencode-ai/plugin";

const idleProbe: Plugin = async (input: PluginInput) => {
  const root = input.directory || input.worktree;
  const logDir = join(root, ".backpressure");
  const logFile = join(logDir, "hook-log.jsonl");
  mkdirSync(logDir, { recursive: true });

  return {
    event: async ({ event }) => {
      if (!event.type.startsWith("session.")) return;
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        type: event.type,
        properties: event.properties,
      });
      appendFileSync(logFile, line + "\n", "utf8");
    },
  };
};

export default idleProbe;
