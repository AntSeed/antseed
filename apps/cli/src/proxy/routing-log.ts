import { appendFile, chmod, mkdir, open, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export class RoutingLog {
  private pending: Promise<void> = Promise.resolve()
  private queued = 0

  constructor(private readonly directory: string, private readonly maxBytes = 1024 * 1024) {}

  record(event: Record<string, unknown>): Promise<void> {
    const line = `${JSON.stringify(event)}\n`
    if (Buffer.byteLength(line) > this.maxBytes || this.queued >= 1000) return Promise.reject(new Error('Routing log capacity exceeded'))
    this.queued++
    const write = this.pending.then(async () => {
      await mkdir(this.directory, { recursive: true })
      const file = join(this.directory, 'routing-operations.jsonl')
      const size = await stat(file).then((entry) => entry.size, (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return 0
        throw error
      })
      if (size + Buffer.byteLength(line) > this.maxBytes) {
        await rename(file, `${file}.1`)
        if (size > this.maxBytes) {
          const handle = await open(`${file}.1`, 'r')
          const tail = Buffer.alloc(this.maxBytes)
          try { await handle.read(tail, 0, tail.length, size - tail.length) } finally { await handle.close() }
          const boundary = tail.indexOf(10)
          await writeFile(`${file}.1`, boundary < 0 ? Buffer.alloc(0) : tail.subarray(boundary + 1), { mode: 0o600 })
        }
        await chmod(`${file}.1`, 0o600)
      }
      await appendFile(file, line, { mode: 0o600 })
      await chmod(file, 0o600)
    }).finally(() => { this.queued-- })
    this.pending = write.catch(() => {})
    return write
  }

  async flush(): Promise<void> { await this.pending }
}
