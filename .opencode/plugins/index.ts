/**
 * backpressure — single-file plugin entrypoint.
 *
 * Composes every backpressure probe into ONE opencode plugin so a consumer can
 * enable all of backpressure with a single entry in their `opencode.json`
 * (e.g. `"plugin": [".opencode/plugins/index.ts"]`) instead of five.
 *
 *   denylist-probe   — hard gates (tool-path, shell-write) + semgrep/sensor
 *                      rules + advise collection
 *   commit-probe     — commit validators (tiers 0/1/2, appeal)
 *   reinject-probe   — deliver collected advisories on session idle
 *   idle-probe       — audit all session.* events to the hook log
 *   permission-probe — audit permission.ask + permission.* bus events
 *
 * Hooks that multiple probes define (e.g. `event`, `tool.execute.before`) are
 * chained in declaration order. Chaining is sequential: if an earlier handler
 * throws to BLOCK a tool call, the chain stops and later handlers do not run,
 * preserving each probe's block semantics.
 */
import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin";
import denylistProbe from "./denylist-probe.ts";
import commitProbe from "./commit-probe.ts";
import reinjectProbe from "./reinject-probe.ts";
import idleProbe from "./idle-probe.ts";
import permissionProbe from "./permission-probe.ts";

const PROBES = [
  denylistProbe,
  commitProbe,
  reinjectProbe,
  idleProbe,
  permissionProbe,
];

/**
 * Merge hook objects, chaining handlers that share a key in declaration order.
 * Sequential: a throwing handler (a BLOCK) aborts the rest of the chain.
 * opencode hooks are all `(input, output?) => Promise<void>`, so a generic
 * chain is safe for every key the probes define.
 */
function mergeHooks(hooks: Hooks[]): Hooks {
  const merged: Record<string, unknown> = {};
  for (const hook of hooks) {
    for (const [key, handler] of Object.entries(hook)) {
      if (handler === undefined) continue;
      const existing = merged[key];
      if (existing === undefined) {
        merged[key] = handler;
      } else {
        const prev = existing as (...args: unknown[]) => Promise<void>;
        const next = handler as (...args: unknown[]) => Promise<void>;
        merged[key] = async (...args: unknown[]) => {
          await prev(...args);
          await next(...args);
        };
      }
    }
  }
  return merged as Hooks;
}

const backpressure: Plugin = async (input: PluginInput) => {
  // Run every probe factory against the same plugin input.
  const hooks = await Promise.all(PROBES.map((probe) => probe(input)));
  return mergeHooks(hooks);
};

export default backpressure;