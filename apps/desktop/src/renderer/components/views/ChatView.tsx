import type { ViewModelProps } from '../types';
import { ChatMessageList } from '../chat/ChatMessageList';

type ChatViewProps = {
  vm: ViewModelProps['vm'];
};

export function ChatView({ vm }: ChatViewProps) {
  return (
    <section id="view-chat" className={vm.viewClass(vm.shellState.activeView === 'chat')} role="tabpanel">
      <div className="page-header">
        <h2>AI Chat</h2>
        <div className="page-header-right">
          <select id="chatModelSelect" className="form-input chat-model-select" value={vm.chatModel} onChange={(event) => vm.setChatModel(event.target.value)}>
            {vm.modelSelectOptions}
          </select>
          <div id="chatProxyStatus" className={vm.toneClass(vm.chatProxy.running ? 'active' : 'idle')}>
            {vm.chatProxy.running ? `Proxy online · :${vm.chatProxy.port}` : 'Proxy offline'}
          </div>
        </div>
      </div>
      <div className="chat-container">
        <div className="chat-main">
          <div id="chatHeader" className="chat-thread-header">
            <div className="chat-thread-title">
              <span className="chat-thread-peer">{vm.chatThreadTitle}</span>
              <span id="chatThreadMeta" className="chat-thread-meta">{vm.chatThreadMeta}</span>
            </div>
            <button id="chatDeleteBtn" className="btn-icon chat-delete-btn" title="Delete conversation" style={{ display: vm.chatActiveConversation ? '' : 'none' }} onClick={() => void vm.deleteConversation()}>Delete</button>
          </div>
          {vm.chatActiveConversation ? (
            <div id="chatAgentHost" className="chat-agent-host">
              <ChatMessageList
                messages={vm.chatRenderableMessages}
                isStreaming={vm.chatSending}
                modelId={vm.chatModel}
                onSendPrompt={vm.sendChatPrompt}
                onAbort={vm.abortChat}
                onModelChange={vm.setChatModel}
              />
            </div>
          ) : (
            <div id="chatMessages" className="chat-messages">
              <div className="chat-welcome">
                <div className="chat-welcome-title">AntSeed AI Chat</div>
                <div className="chat-welcome-subtitle">Send messages through the P2P marketplace to inference providers.</div>
                <div className="chat-welcome-subtitle">Buyer runtime auto-connects to the local proxy. Create a new conversation to begin.</div>
              </div>
            </div>
          )}
          <div id="chatError" className="chat-error" style={{ display: vm.chatError ? '' : 'none' }}>{vm.chatError ?? ''}</div>
        </div>
      </div>
    </section>
  );
}
