import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const PORTABLE_PLUGINS = [
  { root: "plugins/copilot", manifest: "plugin.json", mcp: ".mcp.json" },
  { root: "plugins/cursor", manifest: ".cursor-plugin/plugin.json", mcp: "mcp.json" },
  { root: "plugins/claude", manifest: ".claude-plugin/plugin.json", mcp: ".mcp.json" },
];

export const PORTABLE_MANIFESTS = PORTABLE_PLUGINS.map(
  ({ root, manifest }) => `${root}/${manifest}`,
);

export function syncPortableAssets(root, check = false) {
  const source = PORTABLE_PLUGINS[0];
  for (const target of PORTABLE_PLUGINS.slice(1)) {
    for (const [from, to] of [
      [source.mcp, target.mcp],
      ["skills/claudexor/SKILL.md", "skills/claudexor/SKILL.md"],
    ]) {
      const input = join(root, source.root, from);
      const output = join(root, target.root, to);
      if (check) {
        if (!readFileSync(input).equals(readFileSync(output))) {
          throw new Error(`${target.root}/${to} drifted; run pnpm gen:version`);
        }
      } else {
        mkdirSync(dirname(output), { recursive: true });
        copyFileSync(input, output);
      }
    }
  }
}
