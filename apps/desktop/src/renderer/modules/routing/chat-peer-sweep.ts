import type { DiscoverRow } from '../../core/state';
import type { DesktopBridge } from '../../types/bridge';
import { sameCanonicalModel } from '../catalog/model-identity';
import { routesForSelectedModel } from '../catalog/view-models';

/**
 * Existing automatic chats remain model-only. A seller pin applies only when
 * the user explicitly selects that seller for the individual conversation.
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
  const moved = records.filter((record) => {
    if (record.peerSource === 'user') return false;
    const pinnedService = record.pinnedModel?.split('@').at(-1);
    if (!pinnedService || !sameCanonicalModel(pinnedService, model.serviceId)) return false;
    return record.pinnedModel !== model.serviceId;
  });
  if (moved.length === 0) return false;

  await Promise.all(moved.map((record) =>
    bridge?.buyerConversationsUpdate?.({
      id: record.id,
      pinnedModel: model.serviceId,
      peerSource: 'auto',
    }),
  ));
  return true;
}
