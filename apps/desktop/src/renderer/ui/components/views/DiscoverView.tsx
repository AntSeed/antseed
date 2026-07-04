import { useCallback } from 'react';
import { useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import { DiscoverWelcome } from '../chat/DiscoverWelcome';
import type { ViewName } from '../../types';

type DiscoverViewProps = {
  active: boolean;
  onSelectView: (view: ViewName) => void;
};

export function DiscoverView({ active, onSelectView }: DiscoverViewProps) {
  const serviceOptions = useUiSelector((state) => state.chatServiceOptions);
  const actions = useActions();

  const handleStartChatting = useCallback(
    (serviceValue: string, peerId?: string) => {
      // Reset the visible draft first, then pin the service chosen on Discover.
      // Doing this in the opposite order briefly clears the selected peer and can
      // leave the new chat dropdown showing the previous/wrong peer.
      actions.startNewChat();
      actions.handleServiceChange(serviceValue, peerId);
      onSelectView('chat');
    },
    [actions, onSelectView],
  );

  return (
    <section className={`view${active ? ' active' : ''}`} role="tabpanel">
      <DiscoverWelcome
        serviceOptions={serviceOptions}
        onStartChatting={handleStartChatting}
      />
    </section>
  );
}
