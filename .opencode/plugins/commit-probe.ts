import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import {
  APPEAL_VALIDATOR_NAME,
  DEFAULT_VALIDATOR_STATE,
  extractAppeal,
  formatBlockMessage,
  getCommitContext,
  isCommitCommand,
  loadValidators,
  readValidatorState,
  runAppealValidator,
  validateCommit,
  type CommitExecutor,
} from "../../engine/commit-validators.ts";

const commitProbe: Plugin = async (input: PluginInput) => {
  const root = input.directory || input.worktree;
  const bpDir = join(root, ".backpressure");
  const logFile = join(bpDir, "hook-log.jsonl");
  const validatorsDir =
    process.env.BACKPRESSURE_VALIDATORS_DIR ?? join(bpDir, "validators");
  const stateFile = join(bpDir, "commit-validators.json");
  mkdirSync(bpDir, { recursive: true });
  if (!process.env.BACKPRESSURE_VALIDATORS_DIR) {
    mkdirSync(validatorsDir, { recursive: true });
  }
  let initCreated = false;
  if (!existsSync(stateFile)) {
    writeFileSync(stateFile, JSON.stringify(DEFAULT_VALIDATOR_STATE, null, 2) + "\n");
    initCreated = true;
  }

  const log = (type: string, properties: Record<string, unknown>) => {
    try {
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        type,
        properties,
      });
      appendFileSync(logFile, line + "\n", "utf8");
    } catch {
      // fail open: logging must never block a tool call
    }
  };

  log("probe.commit.init", { created: initCreated, validatorsDir, stateFile });

  const makeExecutor = (): CommitExecutor => async (prompt, model) => {
    const created = await input.client.session.create({
      body: { title: "backpressure commit validator" },
    });
    const sid = created.data?.id;
    if (!sid) throw new Error("validator session create returned no id");
    try {
      const timeoutMs = Number(process.env.BACKPRESSURE_COMMIT_LLM_TIMEOUT_MS ?? 90000);
      const resp = await Promise.race([
        input.client.session.prompt({
          path: { id: sid },
          body: {
            parts: [{ type: "text", text: prompt }],
            ...(model
              ? { model: { providerID: model.providerID, modelID: model.modelID } }
              : {}),
            tools: {
              bash: false,
              edit: false,
              write: false,
              patch: false,
              task: false,
              webfetch: false,
            },
          },
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), timeoutMs),
        ),
      ]);
      const parts = (resp as any)?.data?.parts ?? [];
      return parts
        .filter((p: any) => p?.type === "text")
        .map((p: any) => p.text)
        .join("");
    } finally {
      try {
        await input.client.session.delete({ path: { id: sid } });
      } catch {
        // ignore cleanup errors
      }
    }
  };

  return {
    "tool.execute.before": async (input, output) => {
      const tool = input.tool;
      const sessionID = input.sessionID;
      const callID = input.callID ?? (input as any).call_id;
      if (tool !== "bash") return;
      const args = output?.args ?? (input as any)?.args ?? {};
      const command = typeof args?.command === "string" ? args.command : undefined;
      if (command === undefined) return;
      if (!isCommitCommand(command)) return;

      let blockMessage: string | undefined;

      try {
        const state = readValidatorState(stateFile);
        if (state.validateCommit.mode === "off") {
          log("probe.commit.check", { sessionID, callID, allowed: "mode-off" });
          return;
        }

        const dirs = [validatorsDir];
        const all = loadValidators(dirs, state.overrides.validators);
        const appealValidator = all.find((v) => v.name === APPEAL_VALIDATOR_NAME);
        const validators = all.filter((v) => v.name !== APPEAL_VALIDATOR_NAME);
        if (validators.length === 0) {
          log("probe.commit.check", { sessionID, callID, allowed: "no-validators" });
          return;
        }

        const context = getCommitContext(root, command);

        const executor = makeExecutor();
        const results = await validateCommit(validators, context, {
          executor,
          batchCount: state.validateCommit.batchCount,
          tierModels: {
            tier1: state.models.tier1 ?? undefined,
            tier2: state.models.tier2 ?? undefined,
          },
          onLog: (e, n, d) =>
            log("probe.commit.validator", { sessionID, callID, event: e, name: n, detail: d }),
        });

        if (
          results.length > 0 &&
          results.every(
            (r) => r.decision === "NACK" && r.reason?.startsWith("validator crashed:"),
          )
        ) {
          log("probe.commit.allowed", {
            sessionID,
            callID,
            allowed: "executor-systemic-failure",
          });
          return;
        }

        const nacks = results.filter((r) => r.decision === "NACK");
        if (nacks.length === 0) {
          log("probe.commit.allowed", {
            sessionID,
            callID,
            allowed: "clean",
            validators: results.length,
          });
          return;
        }

        const message = formatBlockMessage(results);

        const appeal = extractAppeal(context.message);
        const nonAppealable = nacks.filter((r) => !r.appealable);
        if (appeal && appealValidator && nonAppealable.length === 0) {
          const verdict = await runAppealValidator(
            appealValidator,
            context,
            results,
            appeal,
            executor,
          );
          log("probe.commit.appeal", {
            sessionID,
            callID,
            appeal,
            decision: verdict.decision,
            reason: verdict.reason,
          });
          if (verdict.decision === "ACK") {
            log("probe.commit.allowed", {
              sessionID,
              callID,
              allowed: "appeal-granted",
            });
            return;
          }
          blockMessage = `${message}\nappeal-system: ${verdict.reason ?? "appeal denied"}`;
        } else {
          blockMessage = message;
        }

        if (state.validateCommit.mode === "warn") {
          log("probe.commit.warn", { sessionID, callID, message: blockMessage });
          return;
        }

        log("probe.commit.blocked", {
          sessionID,
          callID,
          nacks: nacks.map((r) => ({ validator: r.validator, reason: r.reason })),
          message: blockMessage,
        });
      } catch (err) {
        log("probe.commit.error", { sessionID, callID, error: String(err) });
        return;
      }

      if (blockMessage !== undefined) {
        throw new Error("BACKPRESSURE COMMIT VALIDATION: BLOCK\n" + blockMessage);
      }
    },
  };
};

export default commitProbe;