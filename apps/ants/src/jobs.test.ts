import { describe, expect, it } from 'vitest';
import { JobRunner, describeError } from './jobs.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('JobRunner', () => {
  it('runs onFinish before a job reports done or failed', async () => {
    const seen: string[] = [];
    const runner = new JobRunner({ onFinish: () => seen.push('finish') });
    const ok = runner.start('stake', async () => 'ok');
    await tick();
    expect(runner.get(ok.id)?.status).toBe('done');
    const bad = runner.start('move', async () => { throw new Error('nope'); });
    await tick();
    expect(runner.get(bad.id)?.status).toBe('failed');
    expect(seen).toEqual(['finish', 'finish']);
  });

  it('records steps, results, and refuses concurrent signing jobs', async () => {
    const runner = new JobRunner();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const job = runner.start('stake', async (report) => {
      await report('approving');
      await gate;
      await report('confirmed', '0xabc');
      return { hash: '0xabc' };
    });
    expect(job.status).toBe('running');
    await tick();
    expect(() => runner.start('move', async () => undefined)).toThrow(/still running/);
    release();
    await tick();
    const done = runner.get(job.id)!;
    expect(done.status).toBe('done');
    expect(done.steps.map((step) => step.label)).toEqual(['approving', 'confirmed']);
    expect(done.steps[1]?.hash).toBe('0xabc');
    expect(done.result).toEqual({ hash: '0xabc' });
    expect(runner.start('move', async () => undefined).status).toBe('running');
  });

  it('captures failures as readable errors', async () => {
    const runner = new JobRunner();
    const job = runner.start('claim', async () => { throw Object.assign(new Error('execution reverted'), { reason: 'NothingToClaim()' }); });
    await tick();
    expect(runner.get(job.id)?.status).toBe('failed');
    expect(runner.get(job.id)?.error).toBe('execution reverted (NothingToClaim())');
    expect(describeError('plain')).toBe('plain');
  });
});
