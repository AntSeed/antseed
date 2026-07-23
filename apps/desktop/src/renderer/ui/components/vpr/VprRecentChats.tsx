import type { JSX } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowRight01Icon, ArrowRight02Icon } from '@hugeicons/core-free-icons';
import type { VprModelCatalogEntry } from '../../../core/state';
import type { BuyerConversationSummary } from '../../../types/bridge';
import {
  conversationAge,
  conversationPinnedServiceId,
  conversationTitle,
  isConversationActive,
  shortSessionId,
} from '../../../modules/conversations';
import { displayToolName } from '../../../modules/tool-names';
import { BrandIcon } from '../brand/BrandIcon';
import styles from './VprRecentChats.module.scss';

/* Chat rows sampled on the card — the full list lives on the Chats page. */
const CARD_SAMPLE_COUNT = 3;

/** The model a chat runs on: its pin resolved through the catalog, falling
    back to the default-route label for chats that haven't started yet. */
export function chatModelLabel(
  chat: BuyerConversationSummary,
  catalog: VprModelCatalogEntry[],
  defaultModelLabel: string | null,
): string {
  const pinnedServiceId = conversationPinnedServiceId(chat);
  if (!pinnedServiceId) return defaultModelLabel ?? '';
  return catalog.find((entry) => entry.serviceId === pinnedServiceId)?.label ?? pinnedServiceId;
}

/** One chat row: title + session id on the first line, tool · time · model
    on the second — the same layout as the floating pill's dropdown. */
export function VprChatRow({ chat, modelLabel, onClick }: {
  chat: BuyerConversationSummary;
  modelLabel: string;
  onClick: () => void;
}): JSX.Element {
  const title = conversationTitle(chat);
  return (
    <button type="button" className={styles.chatRow} onClick={onClick} title={title}>
      <BrandIcon name={chat.tool} hints={[chat.tool]} size={18} />
      <span className={styles.chatText}>
        <span className={styles.chatTitleLine}>
          <span className={styles.chatTitle}>{title}</span>
          {isConversationActive(chat.lastActiveAt)
            ? <span className={styles.runningDot} role="img" aria-label="Receiving traffic" />
            : null}
          <span className={styles.sessionId}>{shortSessionId(chat.sessionKey)}</span>
        </span>
        <span className={styles.chatMeta}>
          {displayToolName(chat.tool)} · {conversationAge(chat.lastActiveAt)}
          {modelLabel ? ` · ${modelLabel}` : ''}
        </span>
      </span>
      <HugeiconsIcon icon={ArrowRight01Icon} size={14} strokeWidth={2} className={styles.chatChevron} />
    </button>
  );
}

/** Full-width "Recent chats" sample card; every interaction leads to the
    dedicated Chats page (via onOpen), where chats are managed. Renders
    nothing while no tool chat has been seen. */
export function VprRecentChatsCard({ conversations, catalog, defaultModelLabel, onOpen }: {
  conversations: BuyerConversationSummary[];
  catalog: VprModelCatalogEntry[];
  defaultModelLabel: string | null;
  onOpen: () => void;
}): JSX.Element | null {
  if (conversations.length === 0) return null;
  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <span className={styles.headTitle}>Recent chats</span>
        <button type="button" className={styles.viewAll} onClick={onOpen}>
          View all
          <HugeiconsIcon icon={ArrowRight02Icon} size={13} strokeWidth={2} />
        </button>
      </div>
      {conversations.slice(0, CARD_SAMPLE_COUNT).map((chat) => (
        <VprChatRow
          key={chat.id}
          chat={chat}
          modelLabel={chatModelLabel(chat, catalog, defaultModelLabel)}
          onClick={onOpen}
        />
      ))}
    </div>
  );
}
