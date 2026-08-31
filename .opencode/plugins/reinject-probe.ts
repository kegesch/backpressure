import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import {
  collectAdvisories,
  deliveryCount,
  getAdvisories,
  getScanScope,
  incrementDelivery,
  markDelivered,
  MAX_DELIVERIES_PER_SESSION,
} from "../../engine/advisories.ts";
import { composeAdvisory, composeAdvisoryDelta } from "../../engine/core.ts";
import { runSemgrepRescan } from "../../engine/semgrep.ts";
import { runSensorsRescan } from "../../engine/sensors.ts";

const reinjectProbe: Plugin = async (input: PluginInput) => {
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
    event: async ({ event }) => {
      if (event.type !== "session.idle") return;
      try {
        const sessionID = event.properties?.sessionID;
        if (typeof sessionID !== "string" || !sessionID) return;
        const attempts = deliveryCount(sessionID);
        const rescanFlag = (process.env.BACKPRESSURE_IDLE_RESCAN ?? "").toLowerCase();
        const rescanEnabled = rescanFlag === "1" || rescanFlag === "true";
        if (rescanEnabled && attempts < MAX_DELIVERIES_PER_SESSION) {
          const scope = getScanScope(sessionID);
          if (scope.length > 0) {
            const config = {
              protectedRoot: root,
              qualityRoots: [join(root, "engine").replace(/\\/g, "/")],
              rulesDir: process.env.BACKPRESSURE_RULES_DIR || undefined,
              sensorsDir: process.env.BACKPRESSURE_SENSORS_DIR || undefined,
            };
            const [rescan, sensorRescan] = await Promise.all([
              runSemgrepRescan(scope, config),
              runSensorsRescan(scope, config),
            ]);
            const stored = collectAdvisories(sessionID, [...rescan.findings, ...sensorRescan.findings]);
            const rescanProps: Record<string, unknown> = {
              sessionID,
              ran: rescan.ran,
            };
            if (rescan.reason !== undefined) rescanProps.reason = rescan.reason;
            rescanProps.findings = rescan.findings.length;
            rescanProps.stored = stored;
            rescanProps.files = scope.length;
            rescanProps.durationMs = rescan.durationMs;
            rescanProps.sensorFindings = sensorRescan.findings.length;
            if (sensorRescan.reason !== undefined) rescanProps.sensorReason = sensorRescan.reason;
            log("probe.advise.rescan", rescanProps);
          }
        }
        const findings = getAdvisories(sessionID);
        if (findings.length === 0) return;
        const count = deliveryCount(sessionID);
        if (count >= MAX_DELIVERIES_PER_SESSION) {
          log("probe.advise.suppress", {
            sessionID,
            reason: "delivery-cap",
            pending: findings.length,
          });
          return;
        }
        const delivery = count + 1;
        const delta = delivery > 1;
        const text = delta ? composeAdvisoryDelta(findings, delivery) : composeAdvisory(findings);
        incrementDelivery(sessionID);
        try {
          await input.client.session.promptAsync({
            path: { id: sessionID },
            body: {
              parts: [
                {
                  type: "text",
                  synthetic: true,
                  text,
                },
              ],
            },
          });
          markDelivered(sessionID, findings);
          log("probe.advise.deliver", {
            sessionID,
            status: "accepted",
            delivery,
            delta,
            findings: findings.length,
            chars: text.length,
            advisoryVersion: 2,
          });
        } catch (err) {
          log("probe.advise.deliver", {
            sessionID,
            status: "error",
            delivery,
            delta,
            findings: findings.length,
            chars: text.length,
            advisoryVersion: 2,
            error: String(err),
          });
        }
      } catch {
      }
    },
  };
};

export default reinjectProbe;
