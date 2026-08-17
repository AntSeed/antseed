import { useEffect, useMemo, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  ArrowExpand02Icon,
  ArrowRight01Icon,
  ArrowUpRight01Icon,
  Cancel01Icon,
  LeftToRightListBulletIcon,
} from '@hugeicons/core-free-icons';
import type { VprFloatAction, VprFloatApp, VprFloatData } from '../../../types/bridge';
import { conversationAge, conversationMatchesApp } from '../../../modules/routing/conversations';
import { displayToolName } from '../../../modules/routing/tool-names';
import { OverlayScrollArea } from '../OverlayScrollArea';
import { BrandIcon } from '../brand/BrandIcon';
import { VprBackTitle } from '../vpr/VprKit';
import { VprModelRowList } from '../vpr/VprModelRows';
import { VprMark } from '../VprLogo';
import styles from './CompactRoutingPanel.module.scss';

export type CompactRoutingVariant = 'float' | 'menu-bar';
export type CompactRoutingPanelAction = Exclude<
  VprFloatAction,
  'open-main' | { type: 'set-compact'; compact: boolean }
>;
export type CompactRoutingStatus = {
  label: string;
  hint: string;
  tone: 'active' | 'ready' | 'funds' | 'stopped' | 'loading';
};

export function compactRoutingStatus(data: VprFloatData | null): CompactRoutingStatus {
  if (!data || data.ready === false) {
    return { label: 'Loading routing…', hint: 'Refreshing AntSeed routing status.', tone: 'loading' };
  }
  if (data.runtimeOn === false) {
    return {
      label: 'Not connected',
      hint: 'Routing is stopped — apps are not going through AntSeed. Open VPR to start it.',
      tone: 'stopped',
    };
  }
  if (data.needsFunds) {
    return {
      label: 'Balance needed',
      hint: 'Add balance to route requests through the selected paid model.',
      tone: 'funds',
    };
  }
  if (!data.trafficActive) {
    return {
      label: 'Connected · idle',
      hint: 'Connected and waiting. Nothing is being routed until an app sends a request.',
      tone: 'ready',
    };
  }
  const recentService = data.conversations.find(
    (chat) => chat.active && chat.pinnedServiceId,
  )?.pinnedServiceId;
  const modelLabel = recentService
    ? data.models.find((model) => model.serviceId === recentService)?.label ?? recentService
    : null;
  return {
    label: modelLabel ? `Routing · ${modelLabel}` : 'Routing…',
    hint: 'Connected — a request is being routed right now.',
    tone: 'active',
  };
}

function AppMark({ app, tool, size }: { app?: VprFloatApp | null; tool?: string; size: number }) {
  if (app?.iconDataUri) {
    return <img src={app.iconDataUri} alt="" className={styles.appIcon} style={{ width: size, height: size }} />;
  }
  const name = tool ?? app?.name;
  return <BrandIcon name={name} hints={[app?.displayName ?? name]} size={size} />;
}

export function CompactRoutingHeader({
  data,
  variant,
  onAddBalance,
  onOpenChats,
  onOpenFloatingWindow,
  onDismiss,
}: {
  data: VprFloatData | null;
  variant: CompactRoutingVariant;
  onAddBalance: () => void;
  onOpenChats?: () => void;
  onOpenFloatingWindow?: () => void;
  onDismiss?: () => void;
}) {
  const readyData = data?.ready === false ? null : data;
  const status = compactRoutingStatus(readyData);
  return (
    <header className={`${styles.header} ${variant === 'menu-bar' ? styles.headerMenuBar : styles.headerFloat}`}>
      <span className={styles.brandBadge}><VprMark size={26} /></span>
      <span className={styles.headerBody}>
        <span className={styles.balanceLine}>
          <span className={styles.balance}>{readyData?.balanceLabel ?? '—'}</span>
          {readyData?.needsFunds ? (
            <button type="button" className={styles.addBalance} onClick={onAddBalance}>Add balance</button>
          ) : null}
        </span>
        <span className={styles.status} title={status.hint}>
          <span className={`${styles.statusDot} ${styles[`status${status.tone[0]!.toUpperCase()}${status.tone.slice(1)}`]}`} />
          <span className={styles.statusLabel}>{status.label}</span>
        </span>
      </span>
      {variant === 'menu-bar' ? (
        <span className={styles.headerActions}>
          <button type="button" data-menu-item="true" onClick={onOpenChats} title="Open chats" aria-label="Open chats">
            <HugeiconsIcon icon={LeftToRightListBulletIcon} size={17} strokeWidth={2} />
          </button>
          <button type="button" data-menu-item="true" onClick={onOpenFloatingWindow} title="Open floating window" aria-label="Open floating window">
            <HugeiconsIcon icon={ArrowExpand02Icon} size={16} strokeWidth={2} />
          </button>
          <button type="button" data-menu-item="true" onClick={onDismiss} title="Close" aria-label="Close status popover">
            <HugeiconsIcon icon={Cancel01Icon} size={16} strokeWidth={2} />
          </button>
        </span>
      ) : null}
    </header>
  );
}

export function CompactRoutingPanel({
  data,
  variant,
  onAction,
  onOpenMain,
}: {
  data: VprFloatData | null;
  variant: CompactRoutingVariant;
  onAction: (action: CompactRoutingPanelAction) => void;
  onOpenMain: () => void;
}) {
  const [target, setTarget] = useState<string | null>(null);
  const [direction, setDirection] = useState<'forward' | 'back'>('forward');
  const readyData = data?.ready === false ? null : data;
  const conversations = readyData?.conversations ?? [];
  const models = readyData?.models ?? [];
  const favoriteKeys = useMemo(() => new Set(readyData?.favoriteKeys ?? []), [readyData?.favoriteKeys]);
  const pinnedSellers = useMemo(() => new Map(Object.entries(readyData?.pinnedSellers ?? {})), [readyData?.pinnedSellers]);
  const selectedModelValue = readyData?.selectedModel
    ? `${readyData.selectedModel.provider}:${readyData.selectedModel.serviceId}`
    : '';
  const selectedModel = models.find((model) => `${model.provider}:${model.serviceId}` === selectedModelValue) ?? null;
  const modelLabel = selectedModel?.label ?? 'Select model';
  const pinnedSeller = selectedModelValue ? pinnedSellers.get(selectedModelValue) ?? null : null;
  const runtimeOn = readyData?.runtimeOn ?? true;

  const idleApps = useMemo(
    () => (readyData?.apps ?? []).filter((app) => !conversations.some((chat) => conversationMatchesApp(chat.tool, app))),
    [readyData?.apps, conversations],
  );
  const appForTool = useMemo(() => {
    const apps = readyData?.apps ?? [];
    return (tool: string): VprFloatApp | null => apps.find((app) => conversationMatchesApp(tool, app)) ?? null;
  }, [readyData?.apps]);
  const targetChat = target && target !== 'default'
    ? conversations.find((chat) => chat.id === target) ?? null
    : null;

  useEffect(() => {
    if (target && target !== 'default' && !targetChat) {
      setDirection('back');
      setTarget(null);
    }
  }, [target, targetChat]);

  const drillIn = (next: string) => {
    setDirection('forward');
    setTarget(next);
  };
  const drillBack = () => {
    setDirection('back');
    setTarget(null);
  };
  const slideClass = direction === 'back' ? styles.slideBack : styles.slide;
  const targetApp = targetChat ? appForTool(targetChat.tool) : null;
  const targetAppLabel = targetChat ? targetApp?.displayName ?? displayToolName(targetChat.tool) : '';

  return (
    <section className={`${styles.panel} ${variant === 'menu-bar' ? styles.panelMenuBar : styles.panelFloat}`} aria-label="Manage routing sessions">
      {variant === 'menu-bar' && readyData && target === null ? (
        <div className={styles.sectionHead}>
          <span>Recent routing sessions</span>
          <span>{conversations.length > 0 ? `${conversations.length} recent` : ''}</span>
        </div>
      ) : null}
      <OverlayScrollArea className={styles.scroll} contentClassName={styles.scrollContent}>
        {!readyData ? (
          variant === 'menu-bar' ? (
            <div className={styles.loadingState} aria-label="Loading VPR status">
              <span className={styles.loadingMark}><VprMark size={24} /></span>
              <strong>Loading VPR…</strong>
              <small>Fetching balance, models, and recent sessions</small>
            </div>
          ) : (
            <div className={styles.loading} aria-label="Loading routing sessions">
              <span /><span /><span />
            </div>
          )
        ) : target === null ? (
          <div key="list" className={slideClass}>
            {!runtimeOn ? <div className={styles.empty}>Not connected — routing is stopped. Open VPR to start it.</div> : null}
            {runtimeOn && conversations.length === 0 && idleApps.map((app) => (
              <div key={app.name} className={styles.hint}>
                <AppMark app={app} size={variant === 'menu-bar' ? 18 : 16} />
                <span><strong>{app.displayName} connected</strong><small>Start a new session and send your first prompt</small></span>
              </div>
            ))}
            {runtimeOn && conversations.length === 0 && idleApps.length === 0 ? <div className={styles.empty}>No tool chats seen yet</div> : null}
            {runtimeOn ? conversations.map((chat) => {
              const app = appForTool(chat.tool);
              const appLabel = app?.displayName ?? displayToolName(chat.tool);
              const pinnedLabel = chat.pinnedServiceId
                ? models.find((model) => model.serviceId === chat.pinnedServiceId)?.label ?? chat.pinnedServiceId
                : null;
              return (
                <button type="button" data-menu-item="true" key={chat.id} className={styles.row} onClick={() => drillIn(chat.id)} title={chat.title}>
                  <span className={styles.rowIcon}><AppMark app={app} tool={chat.tool} size={variant === 'menu-bar' ? 15 : 16} /></span>
                  <span className={styles.rowText}>
                    <span className={styles.rowTitleLine}>
                      <span className={styles.rowTitle}>{chat.title}</span>
                      {chat.active ? <span className={styles.runningDot} role="img" aria-label="Receiving traffic" /> : null}
                      {chat.cost ? <span className={styles.rowCost}>{chat.cost}</span> : null}
                    </span>
                    <span className={styles.rowMeta}>
                      <span>{appLabel} · {conversationAge(chat.lastActiveAt)}</span>
                      <span className={styles.rowModel}>
                        {pinnedLabel ?? modelLabel}
                        {readyData.showRoutedPeer && chat.routedPeerName ? <em> · {chat.routedPeerName}</em> : null}
                      </span>
                    </span>
                  </span>
                  <HugeiconsIcon icon={ArrowRight01Icon} size={15} strokeWidth={2} className={styles.chevron} />
                </button>
              );
            }) : null}
          </div>
        ) : target === 'default' || targetChat ? (
          <div key={target} className={slideClass}>
            <div className={styles.backHeader}>
              <VprBackTitle title={targetChat?.title ?? 'New session model'} onBack={drillBack} />
              {targetChat ? (
                <button type="button" data-menu-item="true" className={styles.openApp} onClick={() => onAction({ type: 'open-chat-app', conversationId: targetChat.id })} title={`Open ${targetAppLabel}`} aria-label={`Open ${targetAppLabel}`}>
                  <AppMark app={targetApp} tool={targetChat.tool} size={14} />
                  <HugeiconsIcon icon={ArrowUpRight01Icon} size={12} strokeWidth={2} />
                </button>
              ) : null}
            </div>
            <VprModelRowList
              entries={models}
              selectedProvider={targetChat ? undefined : readyData.selectedModel?.provider}
              selectedServiceId={targetChat ? targetChat.pinnedServiceId ?? undefined : readyData.selectedModel?.serviceId}
              favoriteKeys={favoriteKeys}
              compact
              pinnedPeerLabels={targetChat ? undefined : pinnedSellers}
              onSelect={(provider, serviceId) => {
                onAction(targetChat
                  ? { type: 'pin-chat-model', conversationId: targetChat.id, provider, serviceId }
                  : { type: 'select-model', provider, serviceId });
                drillBack();
              }}
              emptyLabel="No models available"
              frameless
            />
          </div>
        ) : null}
      </OverlayScrollArea>
      {readyData && target === null ? (
        <button type="button" data-menu-item="true" className={styles.defaultRow} onClick={() => drillIn('default')}>
          <span>Model for new chats</span>
          <span className={styles.defaultValue}><strong>{modelLabel}</strong>{pinnedSeller ? <small>{pinnedSeller}</small> : null}</span>
          <HugeiconsIcon icon={ArrowRight01Icon} size={15} strokeWidth={2} className={styles.chevron} />
        </button>
      ) : null}
      <button type="button" data-menu-item="true" className={styles.footer} onClick={onOpenMain} title="Open VPR">
        <span><VprMark size={variant === 'menu-bar' ? 16 : 14} />Open VPR</span>
        <HugeiconsIcon icon={ArrowUpRight01Icon} size={variant === 'menu-bar' ? 14 : 13} strokeWidth={2} />
      </button>
    </section>
  );
}
