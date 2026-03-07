import { useUiSnapshot } from '../hooks/useUiSnapshot';

export function StreamingIndicator() {
  const { chatStreamingIndicatorText, chatStreamingActive, runtimeActivity } = useUiSnapshot();

  return (
    <div className="chat-streaming-indicator">
      <div className={chatStreamingActive ? 'is-thinking' : ''}>
        {chatStreamingIndicatorText || 'Generating response...'}
      </div>
      <span>·</span>
      <div className={`runtime-activity-${runtimeActivity.tone}`} aria-live="polite">
        {runtimeActivity.message || 'Idle'}
      </div>
    </div>
  );
}
