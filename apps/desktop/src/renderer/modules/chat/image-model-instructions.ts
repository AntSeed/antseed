import type { DiscoverRow } from '../../core/state';

export const ANTSEED_IMAGES_SKILL_URL = 'https://github.com/AntSeed/antseed/blob/main/skills/antseed-images/README.md';

/**
 * Short handoff for a normal text agent. The reusable workflow and safety
 * rules live in the public AntSeed skill; the desktop supplies only the
 * concrete seller-specific route selected by the user.
 */
export function buildImageModelSkillPrompt(
  route: Pick<DiscoverRow, 'peerId' | 'serviceId'>,
  proxyPort: number,
): string {
  const port = Number.isInteger(proxyPort) && proxyPort > 0 ? proxyPort : 8377;

  return `Use the AntSeed Images skill:
${ANTSEED_IMAGES_SKILL_URL}

Generate an image using these fixed parameters:
- peer_id: ${route.peerId}
- service_id: ${route.serviceId}
- proxy_url: http://127.0.0.1:${String(port)}

Use the user's image request as the prompt. Follow the skill's safety and output instructions. Do not substitute another peer or service.`;
}
