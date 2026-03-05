import { memo } from 'react';

type ChatViewProps = {
  active: boolean;
};

const ChatContent = memo(function ChatContent() {
  return (
    <>
      <div className="page-header">
        <h2>AI Chat</h2>
        <div className="page-header-right">
          <select id="chatModelSelect" className="form-input chat-model-select">
            <option value="">Loading models...</option>
          </select>
          <div id="chatModelStatus" className="connection-badge badge-idle">
            Models idle
          </div>
          <div id="chatProxyStatus" className="connection-badge badge-idle">
            Proxy offline
          </div>
        </div>
      </div>

      <div className="chat-container">
        <div className="chat-main">
          <div id="chatHeader" className="chat-thread-header">
            <div className="chat-thread-title">
              <span className="chat-thread-peer">Conversation</span>
              <span id="chatThreadMeta" className="chat-thread-meta">
                No conversation selected
              </span>
            </div>
            <button
              id="chatDeleteBtn"
              className="btn-icon chat-delete-btn"
              title="Delete conversation"
              style={{ display: 'none' }}
            >
              Delete
            </button>
          </div>
          <div id="chatMessages" className="chat-messages">
            <div className="chat-welcome">
              <div className="chat-welcome-title">AntSeed AI Chat</div>
              <div className="chat-welcome-subtitle">
                Send messages through the P2P marketplace to inference providers.
              </div>
              <div className="chat-welcome-subtitle">
                Buyer runtime auto-connects to the local proxy. Create a new conversation to begin.
              </div>
            </div>
          </div>
          <div className="chat-input-area">
            <textarea
              id="chatInput"
              className="chat-text-input"
              placeholder="Type a message... (Shift+Enter for newline)"
              rows={1}
              disabled
            ></textarea>
            <button id="chatSendBtn" disabled>
              Send
            </button>
            <button id="chatAbortBtn" className="chat-abort-btn" style={{ display: 'none' }}>
              Stop
            </button>
          </div>
          <div id="chatError" className="chat-error" style={{ display: 'none' }}></div>
        </div>
      </div>
    </>
  );
});

export function ChatView({ active }: ChatViewProps) {
  return (
    <section id="view-chat" className={`view${active ? ' active' : ''}`} role="tabpanel">
      <ChatContent />
    </section>
  );
}
