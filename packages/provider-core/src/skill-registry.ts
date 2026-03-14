import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface SkillEntry {
  /** Unique skill name (directory name, e.g., 'visual-explainer'). */
  name: string;
  /** Short description for the catalog shown to the LLM. */
  description: string;
  /** Full SKILL.md content loaded on demand. */
  content: string;
}

/**
 * Loads and manages provider-side skills.
 *
 * Skills follow the same directory structure as Claude Code skills:
 * ```
 * skills/
 *   visual-explainer/
 *     SKILL.md          ← frontmatter (name, description) + instructions
 *     references/       ← optional supporting files
 *     templates/        ← optional supporting files
 *   code-review/
 *     SKILL.md
 * ```
 *
 * Each `SKILL.md` has YAML frontmatter with `name` and `description`:
 * ```
 * ---
 * name: visual-explainer
 * description: Generate self-contained HTML pages for technical diagrams
 * ---
 * # Visual Explainer
 * ... full skill instructions ...
 * ```
 */
export class SkillRegistry {
  private readonly _skills = new Map<string, SkillEntry>();
  private _catalogCache: string | null = null;

  /** Number of registered skills. */
  get size(): number {
    return this._skills.size;
  }

  /** Register a skill programmatically. */
  register(entry: SkillEntry): void {
    this._skills.set(entry.name, entry);
    this._catalogCache = null;
  }

  /** Get a skill by name. */
  get(name: string): SkillEntry | undefined {
    return this._skills.get(name);
  }

  /** Check if a skill exists. */
  has(name: string): boolean {
    return this._skills.has(name);
  }

  /** Get all registered skills. */
  all(): SkillEntry[] {
    return [...this._skills.values()];
  }

  /**
   * Generate the skill catalog text for injection into the system prompt.
   * Cached — only rebuilt when skills are added.
   */
  catalog(): string {
    if (this._catalogCache !== null) return this._catalogCache;

    if (this._skills.size === 0) {
      this._catalogCache = '';
      return '';
    }

    const lines = [...this._skills.values()].map((s) => `- ${s.name}: ${s.description}`);
    this._catalogCache = [
      'Available resources that can be loaded via the antseed_load tool:',
      '',
      ...lines,
    ].join('\n');
    return this._catalogCache;
  }

  /**
   * Load skills from a directory containing skill subdirectories.
   * Each subdirectory must contain a `SKILL.md` file with frontmatter.
   */
  async loadDirectory(skillsDir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(skillsDir);
    } catch {
      return; // Directory doesn't exist — no skills to load
    }

    await Promise.all(
      entries.map(async (entry) => {
        const entryPath = join(skillsDir, entry);
        const skillFile = join(entryPath, 'SKILL.md');

        try {
          const entryStat = await stat(entryPath);
          if (!entryStat.isDirectory()) return;

          const raw = await readFile(skillFile, 'utf-8');
          const parsed = parseFrontmatter(raw);
          const name = parsed.name || entry;
          const description = parsed.description || '';

          const content = raw.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '');
          this.register({ name, description, content });
        } catch {
          // No SKILL.md or not a directory — skip
        }
      }),
    );
  }
}

/**
 * Minimal YAML frontmatter parser — extracts `name` and `description` from
 * the `---` delimited block at the top of a markdown file.
 */
function parseFrontmatter(raw: string): { name: string; description: string } {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return { name: '', description: '' };

  const block = match[1]!;
  let name = '';
  let description = '';

  for (const line of block.split('\n')) {
    const nameMatch = line.match(/^name:\s*(.+)/);
    if (nameMatch) name = nameMatch[1]!.trim();
    const descMatch = line.match(/^description:\s*(.+)/);
    if (descMatch) description = descMatch[1]!.trim();
  }

  return { name, description };
}
