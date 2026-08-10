import type { DiscoverRow } from '../../core/state';
import type { DesktopBridge } from '../../types/bridge';
import { sameCanonicalModel } from '../catalog/model-identity';
import { routesForSelectedModel } from '../catalog/view-models';
import { conversationPinnedPeerId } from './conversations';

/**
 * Re-point existing chats when the user pins a seller for a model.
 *
 * A chat's remembered peer is mere affinity — auto-routing picked it on the
 * chat's first request — so a deliberate per-model seller pin outranks it.
 * Ambient re-ranking never moves a chat; only this sweep does, and only for
 * chats whose peer the user did not choose themselves (`peerSource: 'user'`
 * rows stay put).
 */
export async function sweepAutoChatsToSeller(
  bridge: DesktopBridge | undefined,
  rows: DiscoverRow[],
  model: { provider: string; serviceId: string },
  peerId: string,
): Promise<boolean> {
  // Dispatch must carry the target row's own serviceId — sellers advertise
  // the same model under near-identical ids (see routesForSelectedModel).
  const route = routesForSelectedModel(rows, model)
    .find((candidate) => candidate.peerId === peerId);
  if (!route) return false;

  const records = (await bridge?.buyerConversationsList?.()) ?? [];
  const targetPeer = peerId.toLowerCase();
  const moved = records.filter((record) => {
    if (record.peerSource === 'user') return false;
    const pinnedService = record.pinnedModel?.split('@').slice(1).join('@');
    if (!pinnedService || !sameCanonicalModel(pinnedService, model.serviceId)) return false;
    return conversationPinnedPeerId(record) !== targetPeer;
  });
  if (moved.length === 0) return false;

  await Promise.all(moved.map((record) =>
    bridge?.buyerConversationsUpdate?.({
      id: record.id,
      pinnedModel: `${route.peerId}@${route.serviceId}`,
      peerSource: 'auto',
    }),
  ));
  return true;
}
