import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Skill = { name: string; description: string };

const skillsDir = () => join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "skills");

/** name/description out of SKILL.md's frontmatter, without pulling in a YAML parser. */
function readFrontmatter(path: string): Skill | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return null;

  const fields: Record<string, string> = {};
  let key: string | null = null;
  for (const line of text.slice(3, end).split("\n")) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (match) {
      key = match[1]!;
      fields[key] = match[2]!.trim();
    } else if (key && line.startsWith(" ")) {
      // A folded description continues on indented lines.
      fields[key] = `${fields[key]} ${line.trim()}`.trim();
    }
  }
  const name = fields.name?.replace(/^["']|["']$/g, "");
  return name ? { name, description: (fields.description ?? "").replace(/^["']|["']$/g, "") } : null;
}

/** Skills in ~/.claude/skills — the ones an agent gets when it inherits user settings. */
export function listSkills(): Skill[] {
  const dir = skillsDir();
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => readFrontmatter(join(dir, e.name, "SKILL.md")) ?? { name: e.name, description: "" })
    .sort((a, b) => a.name.localeCompare(b.name));
}
