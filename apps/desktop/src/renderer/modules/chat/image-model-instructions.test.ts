import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DiscoverRow } from '../../core/state';
import {
  ANTSEED_IMAGES_SKILL_URL,
  buildImageModelSkillPrompt,
} from './image-model-instructions';

const route = {
  peerId: 'peer-venice',
  serviceId: 'gpt-image-2',
} satisfies Pick<DiscoverRow, 'peerId' | 'serviceId'>;

test('buildImageModelSkillPrompt references the public skill with the selected route parameters', () => {
  const prompt = buildImageModelSkillPrompt(route, 8377);

  assert.equal(prompt.includes(ANTSEED_IMAGES_SKILL_URL), true);
  assert.match(prompt, /peer_id: peer-venice/);
  assert.match(prompt, /service_id: gpt-image-2/);
  assert.match(prompt, /proxy_url: http:\/\/127\.0\.0\.1:8377/);
  assert.match(prompt, /Use the user's image request as the prompt/);
  assert.match(prompt, /Do not substitute another peer or service/);
  assert.doesNotMatch(prompt, /response_format|authorization|b64_json/);
});
