import { describe, it, expect } from 'vitest';
import { nativeVideoRoute, nativeVideoAcceptance, nativeVideoFacts, requestService, detectRequestServiceApiProtocol, selectTargetProtocolForRequest } from '../src/index.js';

describe('native video API contracts', () => {
  const request = (path: string, body: object = {}, method = 'POST') => ({ requestId: 'request', method, path, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(body)) });

  it('recognizes native paths and never translates into chat or another video API', () => {
    expect(detectRequestServiceApiProtocol(request('/v1/text_to_video'))).toBe('runway-video');
    expect(nativeVideoRoute(request('/v1/tasks/task-123', {}, 'DELETE'))?.action).toBe('cancel');
    expect(nativeVideoRoute(request('/v1beta/models/veo-3.1:predictLongRunning'))?.model).toBe('veo-3.1');
    expect(nativeVideoRoute(request('/v1beta/models/veo-3.1/operations/job', {}, 'GET'))?.resourceId).toBe('models/veo-3.1/operations/job');
    expect(selectTargetProtocolForRequest('runway-video', ['veo-video', 'openai-chat-completions'])).toBeNull();
  });

  it('rejects traversal, unsupported methods, account endpoints and malformed resources', () => {
    for (const path of ['/v1/tasks/../account', '/v1/tasks/%2e%2e', '/v1/tasks', '/v1beta/files/file', '/v1beta/operations/job:cancel']) {
      expect(nativeVideoRoute(request(path))).toBeNull();
    }
    expect(nativeVideoRoute(request('/v1/text_to_video', {}, 'GET'))).toBeNull();
  });

  it('extracts body and path models, with a service header only for follow-ups', () => {
    expect(requestService(request('/v1/text_to_video', { model: 'gen4.5' }))).toBe('gen4.5');
    expect(requestService(request('/v1/text_to_video', { model: 'gen4.5', service: 'extension' }))).toBe('gen4.5');
    expect(requestService(request('/v1/text_to_video', { service: 'gen4.5' }))).toBeUndefined();
    for (const model of ['antseed', `${'a'.repeat(40)}@gen4.5`, ' Gen4.5 ']) {
      expect(requestService(request('/v1/text_to_video', { model }))).toBe(model);
    }
    expect(requestService(request('/v1beta/models/veo:predictLongRunning', { model: 'wrong' }))).toBe('veo');
    expect(requestService(request('/v1beta/models/veo:predictLongRunning', { model: 'wrong', service: 'extension' }))).toBe('veo');
    const followUp = request('/v1/tasks/task', {}, 'GET');
    followUp.headers = { ...followUp.headers, 'x-antseed-service': 'gen4.5' } as typeof followUp.headers;
    expect(requestService(followUp)).toBe('gen4.5');
  });

  it('requires an accepted response with a valid ID and no immediate error', () => {
    const response = (body: object, statusCode = 200) => ({ requestId: 'request', statusCode, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) });
    expect(nativeVideoAcceptance('runway-video', response({ id: 'task' }, 202))).toBe('task');
    expect(nativeVideoAcceptance('veo-video', response({ name: 'models/veo/operations/job' }))).toBe('models/veo/operations/job');
    expect(nativeVideoAcceptance('veo-video', response({ name: 'operations/job', error: {} }))).toBeNull();
    expect(nativeVideoAcceptance('runway-video', response({ id: 'task' }, 503))).toBeNull();
    expect(nativeVideoAcceptance('runway-video', response({ id: '../account' }))).toBeNull();
  });

  it('extracts native quantities without defaulting duration', () => {
    expect(nativeVideoFacts(request('/v1/text_to_video', { duration: 8 }))?.duration).toBe(8);
    expect(nativeVideoFacts(request('/v1beta/models/veo:predictLongRunning', { parameters: { durationSeconds: 8, sampleCount: 2 } }))?.count).toBe(2);
    expect(nativeVideoFacts(request('/v1/text_to_video'))?.duration).toBeUndefined();
    expect(() => nativeVideoFacts(request('/v1/text_to_video', { duration: -1 }))).toThrow();
  });

  it('follows the native Runway and Gemini API field shapes', () => {
    const veo = (parameters: object) => nativeVideoFacts(request('/v1beta/models/veo:predictLongRunning', { instances: [{ prompt: 'cat' }], parameters }));
    expect(veo({ durationSeconds: '6', numberOfVideos: 1 })).toMatchObject({ count: 1, duration: 6 });
    expect(veo({ durationSeconds: 8, numberOfVideos: 2 })).toMatchObject({ count: 2, duration: 8 });
    expect(() => veo({ numberOfVideos: 2, sampleCount: 1 })).toThrow(/disagree/);
    expect(() => veo({ durationSeconds: '6.5' })).toThrow(/duration/);
    expect(nativeVideoFacts(request('/v1/text_to_video', { model: 'seedance2', duration: 'auto' }))?.duration).toBeUndefined();
    expect(() => nativeVideoFacts(request('/v1/text_to_video', { duration: 'soon' }))).toThrow(/duration/);
  });
});
