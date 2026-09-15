import { randomUUID } from 'node:crypto';
import type { JobView, JobStep } from './api-types.js';
import type { StepReporter } from './service/steps.js';

const JOB_RETENTION_MS = 30 * 60 * 1000;

/**
 * In-memory job runner for multi-transaction actions. The dashboard starts a
 * job, then polls it for step-by-step progress (transaction hashes included)
 * instead of holding one HTTP request open across several confirmations.
 */
export class JobRunner {
  private readonly jobs = new Map<string, JobView>();
  private active: string | null = null;

  /** `onFinish` runs after every job, successful or not, before its final status is visible. */
  constructor(private readonly options: { onFinish?: () => void } = {}) {}

  list(): JobView[] {
    this.prune();
    return [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  get(id: string): JobView | undefined {
    this.prune();
    return this.jobs.get(id);
  }

  /** Run `work` as a job. Only one signing job runs at a time so nonces stay ordered. */
  start(kind: string, work: (report: StepReporter) => Promise<unknown>): JobView {
    if (this.active && this.jobs.get(this.active)?.status === 'running') {
      throw new Error(`Another action (${this.jobs.get(this.active)?.kind}) is still running. Wait for it to finish.`);
    }
    const job: JobView = { id: randomUUID(), kind, status: 'running', steps: [], startedAt: Date.now() };
    this.jobs.set(job.id, job);
    this.active = job.id;
    const report: StepReporter = (label, hash) => {
      const step: JobStep = { at: Date.now(), label, ...(hash ? { hash } : {}) };
      job.steps.push(step);
    };
    void work(report).then((result) => {
      this.options.onFinish?.();
      job.status = 'done';
      job.result = result;
      job.finishedAt = Date.now();
    }, (error: unknown) => {
      this.options.onFinish?.();
      job.status = 'failed';
      job.error = describeError(error);
      job.finishedAt = Date.now();
    }).finally(() => {
      if (this.active === job.id) this.active = null;
    });
    return job;
  }

  private prune(): void {
    const cutoff = Date.now() - JOB_RETENTION_MS;
    for (const [id, job] of this.jobs) {
      if (job.status !== 'running' && (job.finishedAt ?? job.startedAt) < cutoff) this.jobs.delete(id);
    }
  }
}

/** Turn ethers/RPC errors into one readable line. */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const candidate = error as Error & { reason?: string; shortMessage?: string; info?: { error?: { message?: string } }; code?: string };
  const revert = candidate.reason ?? candidate.info?.error?.message;
  if (revert && revert !== candidate.message) return `${candidate.shortMessage ?? candidate.message} (${revert})`;
  return candidate.shortMessage ?? candidate.message;
}
