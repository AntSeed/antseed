import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { JobRunner as SharedJobRunner, type JobStorage } from './job-runner.js';

export { describeError } from './job-runner.js';

export class JobRunner extends SharedJobRunner {
  constructor(options: { onFinish?: () => void; journalPath?: string } = {}) {
    const journalPath = options.journalPath;
    const storage: JobStorage | undefined = journalPath ? {
      load() {
        try { return JSON.parse(readFileSync(journalPath, 'utf8')) as unknown; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
          throw new Error('Could not read saved activity. Preserve the activity file and resolve the error before starting the dashboard.', { cause: error });
        }
      },
      save(jobs) {
        mkdirSync(dirname(journalPath), { recursive: true, mode: 0o700 });
        const temporary = `${journalPath}.${randomUUID()}.tmp`;
        writeFileSync(temporary, JSON.stringify(jobs), { mode: 0o600 });
        renameSync(temporary, journalPath);
      },
    } : undefined;
    super({ onFinish: options.onFinish, storage, createId: randomUUID });
  }
}
