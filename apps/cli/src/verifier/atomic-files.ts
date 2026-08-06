import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { canonicalJsonStringify } from '@antseed/fingerprints'

export async function writeJsonAtomic(path: string, value: unknown, canonical = false): Promise<void> {
  const text = canonical ? canonicalJsonStringify(value) : JSON.stringify(value, null, 2)
  await writeTextAtomic(path, text)
}

export async function writeTextAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  const handle = await open(temporary, 'wx')
  try {
    await handle.writeFile(text)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, path)
}

export interface FileLock {
  path: string
  release(): Promise<void>
}

export async function acquirePidFileLock(path: string): Promise<FileLock> {
  await mkdir(dirname(path), { recursive: true })
  const token = randomBytes(16).toString('hex')
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, 'wx')
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }))
        await handle.sync()
      } finally {
        await handle.close()
      }
      return {
        path,
        async release() {
          try {
            const current = JSON.parse(await readFile(path, 'utf8')) as { token?: unknown }
            if (current.token === token) await unlink(path)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const stale = await isStaleLock(path)
      if (!stale) throw new Error(`verifier run already active (lock ${path})`)
      await unlink(path).catch((unlinkError) => {
        if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError
      })
    }
  }
  throw new Error(`could not acquire verifier lock ${path}`)
}

async function isStaleLock(path: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as { pid?: unknown }
    if (!Number.isInteger(parsed.pid) || Number(parsed.pid) <= 0) return true
    try {
      process.kill(Number(parsed.pid), 0)
      return false
    } catch {
      return true
    }
  } catch {
    return true
  }
}
