import { useEffect, useMemo, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowDown01Icon, ArrowExpand02Icon, ArrowRight01Icon, ArrowShrink02Icon, Cancel01Icon, Tick02Icon } from '@hugeicons/core-free-icons';
import type { VprFloatData } from '../../types/bridge';
import { displayToolName } from '../../modules/tool-names';
import { AntStationMark } from '../components/AntStationLogo';
import { BrandIcon } from '../components/brand/BrandIcon';
import { OverlayScrollArea } from '../components/OverlayScrollArea';
import { VprBackTitle } from '../components/vpr/VprKit';
import { VprModelRowList } from '../components/vpr/VprModelRows';
import styles from './FloatApp.module.scss';

/** Compact relative timestamp for chat rows ("now", "5m", "2h", "3d"). */
function relativeTime(timestamp: number): string {
  const delta = Date.now() - timestamp;
  if (delta < 60_000) return 'now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  return `${Math.floor(delta / 86_400_000)}d`;
}

/* Viewport width below this means the window is at compact-chip size (88px)
   rather than the full pill (272px). */
const COMPACT_MAX_WIDTH = 160;

/**
 * Content of the detachable always-on-top pill window (Figma "flowing
 * window", 4075:1842). The main window pushes VprFloatData over IPC; the
 * model dropdown routes 'select-model' / pin actions back. Chats currently
 * receiving traffic show a green pulse on their row.
 */
export function FloatApp() {
  const bridge = window.antseedDesktop;
  const [data, setData] = useState<VprFloatData | null>(null);
  // Whether the conversations panel is open; the window grows while it is.
  const [menuOpen, setMenuOpen] = useState(false);
  // Drill-down inside the conversations panel: null = the list, 'default' =
  // picking the default model, otherwise the conversation id being pinned.
  const [chatTarget, setChatTarget] = useState<string | null>(null);
  // Which way the next level change animates: drilling in slides from the
  // right, going back slides from the left.
  const [navDir, setNavDir] = useState<'forward' | 'back'>('forward');
  const [compact, setCompact] = useState(() => window.innerWidth <= COMPACT_MAX_WIDTH);
  // Compact chip flipped over, showing the expand button on its back face.
  const [flipped, setFlipped] = useState(false);

  // The chip's center buttons must be clickable AND draggable, which
  // -webkit-app-region can't express (drag regions swallow clicks). So the
  // buttons are no-drag and dragging is done by hand: pointer deltas stream
  // to the main process, and a press that never moved past the threshold
  // counts as the click.
  const chipDrag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const chipDragHandlers = {
    onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      chipDrag.current = { x: event.screenX, y: event.screenY, moved: false };
    },
    onPointerMove: (event: React.PointerEvent<HTMLButtonElement>) => {
      const state = chipDrag.current;
      if (!state) return;
      const dx = event.screenX - state.x;
      const dy = event.screenY - state.y;
      if (!state.moved && Math.hypot(dx, dy) < 3) return;
      state.moved = true;
      state.x = event.screenX;
      state.y = event.screenY;
      bridge?.vprFloatMoveBy?.(dx, dy);
    },
    onPointerUp: () => {
      // Leave `moved` for onClick (fires right after) to consume.
      if (chipDrag.current && !chipDrag.current.moved) chipDrag.current = null;
    },
    onPointerCancel: () => {
      chipDrag.current = null;
    },
  };
  /** True when the press that triggered this click was actually a drag. */
  const chipClickWasDrag = () => {
    const dragged = chipDrag.current?.moved ?? false;
    chipDrag.current = null;
    return dragged;
  };

  // Reset the flip whenever the chip leaves/enters compact mode, and flip
  // back on its own if the user doesn't take the expand action.
  useEffect(() => setFlipped(false), [compact]);
  useEffect(() => {
    if (!flipped) return undefined;
    const timer = window.setTimeout(() => setFlipped(false), 4_000);
    return () => window.clearTimeout(timer);
  }, [flipped]);

  // The main process resizes the window; this component just swaps layouts.
  const setCompactMode = (next: boolean) => {
    setCompact(next);
    bridge?.vprFloatAction?.({ type: 'set-compact', compact: next });
  };

  useEffect(() => bridge?.onVprFloatData?.(setData) ?? undefined, [bridge]);

  // The main process owns the compact state (it does the resize). Query it on
  // mount (covers reloads and the push-before-listener race) and subscribe to
  // live changes, so the layout can't desync from the window — even across a
  // dev HMR reload or if the OS clamps the resize size.
  useEffect(() => {
    void bridge?.vprFloatGetCompact?.().then((value) => setCompact(Boolean(value)));
    return bridge?.onVprFloatCompact?.(setCompact);
  }, [bridge]);

  const conversations = data?.conversations ?? [];
  // Level-2 target chat; a chat that ages out of the list mid-visit falls
  // back to the conversations list.
  const targetChat = chatTarget && chatTarget !== 'default'
    ? conversations.find((chat) => chat.id === chatTarget) ?? null
    : null;
  useEffect(() => {
    if (chatTarget && chatTarget !== 'default' && !targetChat) {
      setNavDir('back');
      setChatTarget(null);
    }
  }, [chatTarget, targetChat]);

  /** Enter a drill-down level (slides in from the right). */
  const drillIn = (target: string) => {
    setNavDir('forward');
    setChatTarget(target);
  };
  /** Return to the conversations list (slides in from the left). */
  const drillBack = () => {
    setNavDir('back');
    setChatTarget(null);
  };
  const slideClass = navDir === 'back' ? styles.menuSlideBack : styles.menuSlide;

  // The main process resizes the window around the open dropdown panel.
  useEffect(() => {
    bridge?.vprFloatSetExpanded?.(menuOpen);
    if (!menuOpen) {
      setChatTarget(null);
      setNavDir('forward');
    }
  }, [bridge, menuOpen]);
  useEffect(() => {
    if (compact) setMenuOpen(false);
  }, [compact]);

  const models = data?.models ?? [];
  const favoriteKeys = useMemo(() => new Set(data?.favoriteKeys ?? []), [data?.favoriteKeys]);
  const selectedModelValue = data?.selectedModel
    ? `${data.selectedModel.provider}:${data.selectedModel.serviceId}`
    : '';
  const selectedModel = models.find(
    (model) => `${model.provider}:${model.serviceId}` === selectedModelValue,
  ) ?? null;

  const modelLabel = selectedModel?.label ?? 'Select model';

  if (compact) {
    return (
      <div className={styles.compactRoot}>
      <div className={styles.compactChip}>
        <div className={`${styles.chipFlip}${flipped ? ` ${styles.chipFlipped}` : ''}`}>
          {/* Front: the AntSeed badge. Only the icon itself is clickable —
              the rest of the chip stays a drag handle. */}
          <div className={styles.chipFace}>
            <div className={styles.appBadge}>
              <button
                type="button"
                className={styles.chipIconButton}
                {...chipDragHandlers}
                onClick={() => { if (!chipClickWasDrag()) setFlipped(true); }}
                title="Options"
                aria-label="Show expand button"
              >
                <AntStationMark size={26} />
              </button>
            </div>
          </div>
          {/* Back: the explicit expand action. */}
          <div className={`${styles.chipFace} ${styles.chipFaceBack}`}>
            <button
              type="button"
              className={styles.chipExpandButton}
              {...chipDragHandlers}
              onClick={() => { if (!chipClickWasDrag()) setCompactMode(false); }}
              title="Expand"
              aria-label="Expand floating window"
            >
              <HugeiconsIcon icon={ArrowExpand02Icon} size={18} strokeWidth={2} />
            </button>
          </div>
        </div>
      </div>
      </div>
    );
  }

  return (
    <div className={styles.pill}>
      <button
        type="button"
        className={styles.appBadge}
        onClick={() => bridge?.vprFloatAction?.('open-main')}
        title="Open AntSeed"
        aria-label="Open AntSeed"
      >
        <AntStationMark size={26} />
      </button>

      <div className={styles.body}>
        {/* The model label doubles as the single dropdown trigger: it opens
            the conversations panel, whose "Default model" row drills into the
            model list. */}
        <button
          type="button"
          className={styles.modelTrigger}
          onClick={() => setMenuOpen(!menuOpen)}
          aria-expanded={menuOpen}
          aria-label="Model and conversations"
          title={modelLabel}
        >
          <span className={styles.triggerLabel}>{modelLabel}</span>
          <HugeiconsIcon icon={ArrowDown01Icon} size={12} strokeWidth={2} />
        </button>

        {data?.usageLabel ? <span className={styles.usage}>{data.usageLabel}</span> : null}
      </div>

      {/* Manage conversations: level 1 lists the default-model row plus one
          row per chat; clicking a row slides to the shared rich model list
          (same rows as the Home dropdown) with a back header. */}
      {menuOpen ? (
        <div className={styles.menuPanel} aria-label="Manage conversations">
          <OverlayScrollArea className={styles.menuScroll} contentClassName={styles.menuScrollContent}>
          {chatTarget === null ? (
            <div key="list" className={slideClass}>
              <button
                type="button"
                className={styles.menuRow}
                onClick={() => drillIn('default')}
              >
                <span className={styles.menuRowText}>
                  <span className={styles.menuRowTitle}>Default model</span>
                  <span className={styles.menuRowMeta}>applies to every chat without a pin</span>
                </span>
                <span className={styles.menuRowValue}>{modelLabel}</span>
                <HugeiconsIcon icon={ArrowRight01Icon} size={14} strokeWidth={2} className={styles.menuRowChevron} />
              </button>
              {conversations.length === 0 ? (
                <div className={styles.menuEmpty}>No tool chats seen yet</div>
              ) : conversations.map((chat) => {
                const pinLabel = chat.pinnedServiceId
                  ? (models.find((model) => model.serviceId === chat.pinnedServiceId)?.label ?? chat.pinnedServiceId)
                  : 'Auto';
                return (
                  <button
                    type="button"
                    key={chat.id}
                    className={styles.menuRow}
                    onClick={() => drillIn(chat.id)}
                    title={chat.title}
                  >
                    <BrandIcon name={chat.tool} hints={[chat.tool]} size={16} />
                    <span className={styles.menuRowText}>
                      <span className={styles.menuRowTitleLine}>
                        <span className={styles.menuRowTitle}>{chat.title}</span>
                        {/* Green pulse while the chat is receiving traffic —
                            same signal as the chat list's running dot. */}
                        {chat.active ? <span className={styles.runningDot} role="img" aria-label="Receiving traffic" /> : null}
                      </span>
                      <span className={styles.menuRowMeta}>{displayToolName(chat.tool)} · {relativeTime(chat.lastActiveAt)}</span>
                    </span>
                    <span className={styles.menuRowValue}>{pinLabel}</span>
                    <HugeiconsIcon icon={ArrowRight01Icon} size={14} strokeWidth={2} className={styles.menuRowChevron} />
                  </button>
                );
              })}
            </div>
          ) : (chatTarget === 'default' || targetChat) ? (
            <div key={chatTarget} className={slideClass}>
              {/* Same back-title chrome as the inner VPR pages. */}
              <div className={styles.menuBack}>
                <VprBackTitle
                  title={targetChat ? targetChat.title : 'Default model'}
                  onBack={drillBack}
                />
              </div>
              {targetChat ? (
                <button
                  type="button"
                  className={`${styles.menuRow}${!targetChat.pinnedServiceId ? ` ${styles.menuRowActive}` : ''}`}
                  onClick={() => {
                    bridge?.vprFloatAction?.({ type: 'clear-chat-pin', conversationId: targetChat.id });
                    drillBack();
                  }}
                >
                  <span className={styles.menuRowText}>
                    <span className={styles.menuRowTitle}>Auto</span>
                    <span className={styles.menuRowMeta}>follow the default model · {modelLabel}</span>
                  </span>
                  {!targetChat.pinnedServiceId ? <HugeiconsIcon icon={Tick02Icon} size={13} strokeWidth={2} /> : null}
                </button>
              ) : null}
              <VprModelRowList
                entries={models}
                selectedProvider={targetChat ? undefined : data?.selectedModel?.provider}
                selectedServiceId={targetChat ? (targetChat.pinnedServiceId ?? undefined) : data?.selectedModel?.serviceId}
                favoriteKeys={favoriteKeys}
                compact
                onSelect={(provider, serviceId) => {
                  if (targetChat) {
                    bridge?.vprFloatAction?.({ type: 'pin-chat-model', conversationId: targetChat.id, provider, serviceId });
                  } else {
                    bridge?.vprFloatAction?.({ type: 'select-model', provider, serviceId });
                  }
                  drillBack();
                }}
                emptyLabel="No models available"
                frameless
              />
            </div>
          ) : null}
          </OverlayScrollArea>
        </div>
      ) : null}

      <button
        type="button"
        className={styles.shrink}
        onClick={() => setCompactMode(true)}
        aria-label="Shrink to badge"
        title="Shrink"
      >
        <HugeiconsIcon icon={ArrowShrink02Icon} size={13} strokeWidth={2} />
      </button>

      <button
        type="button"
        className={styles.close}
        onClick={() => { void bridge?.vprFloatClose?.(); }}
        aria-label="Close floating window"
        title="Close"
      >
        <HugeiconsIcon icon={Cancel01Icon} size={14} strokeWidth={2} />
      </button>
    </div>
  );
}
