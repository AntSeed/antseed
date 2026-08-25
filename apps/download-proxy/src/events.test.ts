import {describe, expect, it} from 'vitest';
import {endEvent, startEvent, unresolvedEvent, type DownloadContext} from './events';

const ctx: DownloadContext = {
  target: {platform: 'mac', arch: 'arm64'},
  asset: 'AntSeed-VPR-0.2.31-arm64.dmg',
  tag: 'v0.2.31',
  country: 'DE',
  partial: false,
  totalBytes: 200_000_000,
};

describe('download events', () => {
  it('builds a started event with the download context', () => {
    const event = startEvent(ctx);
    expect(event.name).toBe('download_started');
    expect(event.params).toMatchObject({
      platform: 'mac',
      arch: 'arm64',
      release_tag: 'v0.2.31',
      country: 'DE',
      partial: 0,
      total_bytes: 200_000_000,
    });
  });

  it('names the end event by completion and includes transfer stats', () => {
    const completed = endEvent(ctx, {completed: true, durationMs: 30_000});
    expect(completed.name).toBe('download_completed');
    expect(completed.params).toMatchObject({bytes_sent: 200_000_000, duration_ms: 30_000});

    // Aborted transfers delivered an unknown prefix — no bytes_sent claim.
    const aborted = endEvent(ctx, {completed: false, durationMs: 8_000});
    expect(aborted.name).toBe('download_aborted');
    expect(aborted.params['bytes_sent']).toBeUndefined();
    expect(aborted.params['duration_ms']).toBe(8_000);
  });

  it('omits byte counts when the total size is unknown', () => {
    const event = endEvent({...ctx, totalBytes: null}, {completed: true, durationMs: 5});
    expect(event.params['bytes_sent']).toBeUndefined();
    expect(event.params['total_bytes']).toBeUndefined();
  });

  it('marks range responses as partial', () => {
    const event = startEvent({...ctx, partial: true});
    expect(event.params['partial']).toBe(1);
  });

  it('builds unresolved events with a reason', () => {
    const event = unresolvedEvent({platform: 'win', arch: 'arm64'}, 'v0.2.31', 'no_matching_asset');
    expect(event.name).toBe('download_unresolved');
    expect(event.params).toMatchObject({platform: 'win', reason: 'no_matching_asset'});
  });
});
