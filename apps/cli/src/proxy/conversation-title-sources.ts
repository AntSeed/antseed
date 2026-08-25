import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type IntegrationConversationTitleResolver = (tool: string, sessionKey: string) => string | null

type IntegrationConversationTitleResolverOptions = {
  codexSessionIndexFile?: string
}

class CodexSessionIndexTitleSource {
  private readonly _file: string
  private _signature: string | null | undefined
  private _titles = new Map<string, string>()

  constructor(file: string) {
    this._file = file
  }

  get(sessionKey: string): string | null {
    this._refresh()
    return this._titles.get(sessionKey) ?? null
  }

  private _refresh(): void {
    let signature: string
    try {
      const stat = statSync(this._file)
      signature = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`
    } catch {
      if (this._signature !== null) this._titles = new Map()
      this._signature = null
      return
    }
    if (signature === this._signature) return

    let raw: string
    try {
      raw = readFileSync(this._file, 'utf8')
    } catch {
      return
    }

    const titles = new Map<string, string>()
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line) as Record<string, unknown>
        const id = typeof entry.id === 'string' ? entry.id.trim() : ''
        const title = typeof entry.thread_name === 'string'
          ? entry.thread_name.replace(/\s+/g, ' ').trim()
          : ''
        if (id && title) titles.set(id, title)
      } catch { /* one malformed entry must not hide the remaining Codex titles */ }
    }
    this._titles = titles
    this._signature = signature
  }
}

export function createIntegrationConversationTitleResolver(
  options: IntegrationConversationTitleResolverOptions = {},
): IntegrationConversationTitleResolver {
  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
  const codexTitles = new CodexSessionIndexTitleSource(
    options.codexSessionIndexFile ?? join(codexHome, 'session_index.jsonl'),
  )
  return (tool, sessionKey) => tool === 'codex-desktop' ? codexTitles.get(sessionKey) : null
}
