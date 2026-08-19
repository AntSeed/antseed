import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { VprModelCatalogEntry } from '../../core/state';
import {
  ANTSEED_IMAGES_SKILL_URL,
  buildImageModelSkillPrompt,
} from './image-model-instructions';

const model = {
  serviceId: 'gpt-image-2',
  label: 'GPT Image 2',
} satisfies Pick<VprModelCatalogEntry, 'serviceId' | 'label'>;

test('buildImageModelSkillPrompt discovers image models and uses model-only routing', () => {
  const prompt = buildImageModelSkillPrompt(model, 8377);

  assert.equal(prompt.includes(ANTSEED_IMAGES_SKILL_URL), true);
  assert.match(prompt, /\/v1\/models\?type=images/);
  assert.match(prompt, /model: gpt-image-2/);
  assert.match(prompt, /display_name: GPT Image 2/);
  assert.match(prompt, /proxy_url: http:\/\/127\.0\.0\.1:8377/);
  assert.match(prompt, /Use the user's image request as the prompt/);
  assert.match(prompt, /do not pin a peer/i);
  assert.doesNotMatch(prompt, /peer_id|peer-venice|@gpt-image-2/);
  assert.doesNotMatch(prompt, /response_format|authorization|b64_json/);
});
