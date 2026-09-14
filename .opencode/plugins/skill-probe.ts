/**
 * backpressure — skill probe.
 *
 * Ensures the `backpressure-extend` skill (which ships inside `.opencode/`) is
 * registered under `skills.paths` in the project's `opencode.json`, so agents
 * in the project see it regardless of opencode's default discovery.
 *
 * v1 opencode has no plugin skill-injection hook, so the only way to make the
 * skill available is via config. The skill folder is resolved relative to THIS
 * file — not the project root — so the path stays correct for any install
 * layout (auto-discovered plugin, config-listed plugin, npm package, symlink):
 *
 *   <this dir>/../skills  →  the absolute skill folder that ships with the plugin
 *
 * This probe has no runtime hooks; its work runs once at load time.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin, PluginInput } from "@opencode-ai/plugin";

/** This plugin's own directory (opencode loads plugins with Bun). */
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
/** The absolute skill folder that ships with the plugin, one level up. */
const SKILL_DIR = resolve(PLUGIN_DIR, "..", "skills");

/**
 * Ensure the project's `opencode.json` registers our skill folder under
 * `skills.paths`. No-op when the path is already present.
 *
 * Preserves comments: the config is only parse/re-stringified when it is valid
 * JSON; otherwise the path is inserted at the text level so a commented config
 * is left untouched otherwise.
 */
export function ensureSkillInConfig(projectRoot: string): string {
  const configFile = join(projectRoot, "opencode.json");
  const absent = !existsSync(configFile);
  let text = absent ? "" : readFileSync(configFile, "utf8");

  // Text already lists our absolute skill dir under skills.paths → nothing to do.
  if (text.includes(JSON.stringify(SKILL_DIR))) return configFile;

  if (absent) {
    writeFileSync(
      configFile,
      JSON.stringify({ $schema: "https://opencode.ai/config.json", skills: { paths: [SKILL_DIR] } }, null, 2) + "\n",
      "utf8",
    );
    return configFile;
  }

  // Try a clean JSON parse/merge (valid JSON, no comments).
  try {
    const config = JSON.parse(text);
    config.skills ??= { paths: [] };
    if (!Array.isArray(config.skills.paths)) config.skills.paths = [];
    if (!config.skills.paths.includes(SKILL_DIR)) config.skills.paths.push(SKILL_DIR);
    writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n", "utf8");
    return configFile;
  } catch {
    // JSON-with-comments (or unparseable) — do a targeted text insert so we never
    // mangle a commented config. Insert into an existing skills.paths array, or
    // add a skills block before the closing brace.
    const pathLiteral = JSON.stringify(SKILL_DIR);
    const skillsRe = /"skills"\s*:\s*\{/;
    if (skillsRe.test(text)) {
      const pathsRe = /"paths"\s*:\s*\[([^\]]*)\]/;
      if (pathsRe.test(text)) {
        text = text.replace(pathsRe, (m, body: string) =>
          body.trim() === "" ? `"paths": [${pathLiteral}]` : `"paths": [${pathLiteral}, ${body.trim()}]`,
        );
      } else {
        // has "skills": { ... } but no paths array — inject one after the brace.
        text = text.replace(skillsRe, `"skills": { "paths": [${pathLiteral}],`);
      }
    } else {
      const close = text.lastIndexOf("}");
      if (close >= 0) {
        const prefix = text.slice(0, close).trimEnd();
        text = prefix.endsWith(",") || prefix.endsWith("{") ? `${prefix}\n, "skills": { "paths": [${pathLiteral}] }}\n` : `${prefix},\n  "skills": { "paths": [${pathLiteral}] }\n}\n`;
      }
    }
    writeFileSync(configFile, text, "utf8");
    return configFile;
  }
}

const skillProbe: Plugin = async (input: PluginInput) => {
  const root = input.directory || input.worktree;
  try {
    ensureSkillInConfig(root);
  } catch {
    // fail open: never block plugin load over config bookkeeping
  }
  // This probe performs its work at load time and registers no runtime hooks.
  return {};
};

export default skillProbe;