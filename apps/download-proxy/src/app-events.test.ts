import {describe, expect, it} from 'vitest';
import {handleAppEvents, handleInstallerBeacon, parseAppEventsBody} from './app-events';
import {mintInstallToken, stampAssetName} from './attribution';
import type {DownloadEvent, Ga4Delivery} from './events';

const SECRET = 'test-secret';
const NOW = 1_757_500_000_000;
const env = {GA4_MEASUREMENT_ID: 'G-TEST', GA4_API_SECRET: 's', ATTRIBUTION_SECRET: SECRET};
const ids = {clientId: '1234567890.1234567890', sessionId: '1757499000'};

function collector() {
  const delivered: Array<{event: DownloadEvent; ga: Ga4Delivery}> = [];
  const pending: Promise<unknown>[] = [];
  const ctx = {waitUntil: (p: Promise<unknown>) => void pending.push(p)};
  const deliver = async (event: DownloadEvent, ga: Ga4Delivery) => {
    delivered.push({event, ga});
  };
  return {delivered, ctx, deliver, flush: () => Promise.all(pending)};
}

function post(body: unknown): Request {
  return new Request('https://download.antseed.com/app-events', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(body),
  });
}

describe('parseAppEventsBody', () => {
  it('keeps only catalogued events and allowlisted params', () => {
    const body = parseAppEventsBody({
      token: 't',
      install_id: '9B2F4C1E-7A3D-4E5F-8A9B-0C1D2E3F4A5B',
      events: [
        {name: 'app_activated', params: {kind: 'tool_connected', app: 'codex', wallet: '0xabc', is_first_deposit: true}},
        {name: 'not_an_event', params: {}},
        {name: 'app_first_opened'},
      ],
    });
    expect(body).toEqual({
      token: 't',
      installId: '9b2f4c1e-7a3d-4e5f-8a9b-0c1d2e3f4a5b',
      events: [
        {name: 'app_activated', params: {kind: 'tool_connected', app: 'codex', is_first_deposit: 1}},
        {name: 'app_first_opened', params: {}},
      ],
    });
  });

  it('rejects empty, malformed, and unknown-only reports', () => {
    expect(parseAppEventsBody(null)).toBeNull();
    expect(parseAppEventsBody({events: []})).toBeNull();
    expect(parseAppEventsBody({events: [{name: 'nope'}]})).toBeNull();
    expect(parseAppEventsBody({install_id: 'not-a-uuid', events: [{name: 'app_first_opened'}]})?.installId).toBeNull();
  });
});

describe('POST /app-events', () => {
  it('forwards milestones under the token’s GA ids', async () => {
    const token = await mintInstallToken(ids, SECRET, NOW);
    const c = collector();
    const res = await handleAppEvents(
      post({token, events: [{name: 'app_first_opened', params: {platform: 'win32'}}, {name: 'app_activated', params: {kind: 'first_chat'}}]}),
      env,
      c.ctx,
      {deliver: c.deliver, nowMs: NOW + 60_000},
    );
    expect(res.status).toBe(204);
    await c.flush();
    expect(c.delivered.map(d => d.event.name)).toEqual(['app_first_opened', 'app_activated']);
    expect(c.delivered[0]!.ga.ids).toEqual({clientId: ids.clientId, sessionId: ids.sessionId});
  });

  it('falls back to the install id when the token is missing or invalid', async () => {
    const c = collector();
    const res = await handleAppEvents(
      post({token: '1.bad.bad', install_id: '9b2f4c1e-7a3d-4e5f-8a9b-0c1d2e3f4a5b', events: [{name: 'app_first_opened'}]}),
      env,
      c.ctx,
      {deliver: c.deliver, nowMs: NOW},
    );
    expect(res.status).toBe(204);
    await c.flush();
    expect(c.delivered[0]!.ga.ids).toEqual({clientId: null, sessionId: null, fallbackClientId: '9b2f4c1e-7a3d-4e5f-8a9b-0c1d2e3f4a5b'});
  });

  it('answers 400 for bad JSON and 413 for oversized bodies', async () => {
    const c = collector();
    const bad = new Request('https://download.antseed.com/app-events', {method: 'POST', body: '{'});
    expect((await handleAppEvents(bad, env, c.ctx, {deliver: c.deliver})).status).toBe(400);
    const big = post({events: [{name: 'app_first_opened', params: {kind: 'x'.repeat(9_000)}}]});
    expect((await handleAppEvents(big, env, c.ctx, {deliver: c.deliver})).status).toBe(413);
    expect(c.delivered).toHaveLength(0);
  });
});

describe('GET /i installer beacon', () => {
  it('attributes installer_started from the stamped filename', async () => {
    const token = (await mintInstallToken(ids, SECRET, NOW))!;
    const name = stampAssetName('AntSeed-VPR-Setup-0.2.38.exe', token);
    const c = collector();
    const res = await handleInstallerBeacon(new URL(`https://download.antseed.com/i?f=${name}`), env, c.ctx, {deliver: c.deliver, nowMs: NOW});
    expect(res.status).toBe(204);
    await c.flush();
    expect(c.delivered[0]!.event).toEqual({name: 'installer_started', params: {platform: 'win', install_source: 'nsis'}});
    expect(c.delivered[0]!.ga.ids?.clientId).toBe(ids.clientId);
  });

  it('still counts an unstamped installer, unattributed', async () => {
    const c = collector();
    const res = await handleInstallerBeacon(new URL('https://download.antseed.com/i?f=AntSeed-VPR-Setup-0.2.38.exe'), env, c.ctx, {deliver: c.deliver, nowMs: NOW});
    expect(res.status).toBe(204);
    await c.flush();
    expect(c.delivered[0]!.ga.ids?.clientId).toBeNull();
    expect((await handleInstallerBeacon(new URL('https://download.antseed.com/i?f=../etc'), env, c.ctx, {deliver: c.deliver})).status).toBe(400);
  });
});
