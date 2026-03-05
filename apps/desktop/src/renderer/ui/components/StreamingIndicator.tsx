import { memo } from 'react';

export const StreamingIndicator = memo(function StreamingIndicator() {
  return (
    <div className="chat-streaming-indicator">
      <div id="chatStreamingIndicator">Generating response...</div>
      <span>·</span>
      <div id="runtimeActivity" aria-live="polite">
        Idle
      </div>
    </div>
  );
});
