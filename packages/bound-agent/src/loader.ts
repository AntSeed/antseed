import { readFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';

export interface KnowledgeModule {
  /** Unique name for this knowledge module. */
  name: string;
  /** Short description shown to the LLM during knowledge selection. */
  description: string;
  /** Full markdown content loaded from file. */
  content: string;
}

export interface BoundAgentDefinition {
  /** Agent name. */
  name: string;
  /** Persona / system prompt content (loaded from markdown file). */
  persona: string;
  /** Hard rules the agent must follow. */
  guardrails: string[];
  /** Knowledge modules available for selective loading. */
  knowledge: KnowledgeModule[];
  /** Custom confidentiality prompt. Uses a built-in default when omitted. */
  confidentialityPrompt?: string;
}

/**
 * Shape of the `agent.json` manifest file in a bound agent directory.
 *
 * Example:
 * ```json
 * {
 *   "name": "social-media-advisor",
 *   "persona": "./persona.md",
 *   "guardrails": [
 *     "Never write posts without explicit request",
 *     "Always disclose AI when asked"
 *   ],
 *   "knowledge": [
 *     { "name": "linkedin-posting", "description": "Creating LinkedIn posts", "file": "./knowledge/linkedin.md" },
 *     { "name": "x-threads", "description": "Writing X threads", "file": "./knowledge/x-threads.md" }
 *   ]
 * }
 * ```
 */
interface AgentManifest {
  name: string;
  persona?: string;
  guardrails?: string[];
  knowledge?: { name: string; description: string; file: string }[];
  confidentialityPrompt?: string;
}

/**
 * Load a bound agent definition from a directory containing `agent.json`.
 *
 * The directory structure:
 * ```
 * my-agent/
 *   agent.json           # manifest
 *   persona.md           # persona / system prompt
 *   knowledge/           # knowledge modules (markdown files)
 *     topic-a.md
 *     topic-b.md
 * ```
 */
export async function loadBoundAgent(agentDir: string): Promise<BoundAgentDefinition> {
  const manifestPath = join(agentDir, 'agent.json');
  const raw = await readFile(manifestPath, 'utf-8');
  const manifest: AgentManifest = JSON.parse(raw) as AgentManifest;

  if (!manifest.name) {
    throw new Error('agent.json must have a "name" field');
  }

  // Load persona
  let persona = '';
  if (manifest.persona) {
    const personaPath = isAbsolute(manifest.persona)
      ? manifest.persona
      : join(agentDir, manifest.persona);
    persona = await readFile(personaPath, 'utf-8');
  }

  // Load knowledge modules
  const knowledge: KnowledgeModule[] = [];
  if (manifest.knowledge) {
    for (const entry of manifest.knowledge) {
      if (!entry.name || !entry.file) {
        throw new Error(`Knowledge entry must have "name" and "file" fields`);
      }
      const filePath = isAbsolute(entry.file)
        ? entry.file
        : join(agentDir, entry.file);
      const content = await readFile(filePath, 'utf-8');
      knowledge.push({ name: entry.name, description: entry.description ?? '', content });
    }
  }

  return {
    name: manifest.name,
    persona,
    guardrails: manifest.guardrails ?? [],
    knowledge,
    confidentialityPrompt: manifest.confidentialityPrompt,
  };
}
