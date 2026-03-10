import { useCallback } from 'react';
import { useUiSnapshot } from '../../hooks/useUiSnapshot';
import { useActions } from '../../hooks/useActions';
import { DiscoverWelcome } from '../chat/DiscoverWelcome';
import type { ViewName } from '../../types';

type DiscoverViewProps = {
  active: boolean;
  onSelectView: (view: ViewName) => void;
};

export function DiscoverView({ active, onSelectView }: DiscoverViewProps) {
  const snap = useUiSnapshot();
  const actions = useActions();

  const handleStartChatting = useCallback(
    (modelValue: string) => {
      actions.handleModelChange(modelValue);
      actions.startNewChat();
      onSelectView('chat');
    },
    [actions, onSelectView],
  );

  return (
    <section className={`view${active ? ' active' : ''}`} role="tabpanel">
      <DiscoverWelcome
        modelOptions={snap.chatModelOptions}
        onStartChatting={handleStartChatting}
      />
    </section>
  );
}
