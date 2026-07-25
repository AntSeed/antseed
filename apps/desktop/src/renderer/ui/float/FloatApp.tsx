import { useEffect, useMemo, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowExpand02Icon, ArrowRight01Icon, ArrowShrink02Icon, ArrowUpRight01Icon, Cancel01Icon } from '@hugeicons/core-free-icons';
import type { VprFloatData } from '../../types/bridge';
import { conversationAge, conversationMatchesApp } from '../../modules/conversations';
import { displayToolName } from '../../modules/tool-names';
import { AntStationMark } from '../components/AntStationLogo';
import { BrandIcon } from '../components/brand/BrandIcon';
import { OverlayScrollArea } from '../components/OverlayScrollArea';
import { VprBackTitle } from '../components/vpr/VprKit';
import { VprModelRowList } from '../components/vpr/VprModelRows';
import styles from './FloatApp.module.scss';

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

  // The expanded pill and the open dropdown drag the same way as the chip:
  // manual pointer deltas, with a press that never crossed the threshold
  // counting as the click. Capture starts only once movement crosses the
  // threshold — capturing on pointerdown would retarget the eventual click
  // away from dropdown rows and make them unclickable.
  const pillDrag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const pillDragHandlers = {
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      pillDrag.current = { x: event.screenX, y: event.screenY, moved: false };
    },
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
      const state = pillDrag.current;
      if (!state) return;
      const dx = event.screenX - state.x;
      const dy = event.screenY - state.y;
      if (!state.moved && Math.hypot(dx, dy) < 3) return;
      if (!state.moved) {
        state.moved = true;
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      state.x = event.screenX;
      state.y = event.screenY;
      bridge?.vprFloatMoveBy?.(dx, dy);
    },
    onPointerUp: () => {
      // Leave `moved` for the click (fires right after) to consume.
      if (pillDrag.current && !pillDrag.current.moved) pillDrag.current = null;
    },
    onPointerCancel: () => {
      pillDrag.current = null;
    },
    // Swallow the click a drag would otherwise end with — runs in the
    // capture phase so dropdown rows never see it.
    onClickCapture: (event: React.MouseEvent<HTMLElement>) => {
      const dragged = pillDrag.current?.moved ?? false;
      pillDrag.current = null;
      if (dragged) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
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

  // Current compact state for the data handler below — the subscription is
  // installed once, so it can't read the `compact` state directly.
  const compactRef = useRef(compact);
  useEffect(() => { compactRef.current = compact; }, [compact]);

  useEffect(() => bridge?.onVprFloatData?.((next) => {
    setData(next);
    // A connect-triggered open lands with the dropdown already expanded, so
    // the "start a new session" guidance is visible without a click. Leave
    // compact mode first — the dropdown can't render in the chip.
    if (next.openMenu) {
      if (compactRef.current) {
        setCompact(false);
        bridge.vprFloatAction?.({ type: 'set-compact', compact: false });
      }
      setMenuOpen(true);
    }
  }) ?? undefined, [bridge]);

  // The main process owns the compact state (it does the resize). Query it on
  // mount (covers reloads and the push-before-listener race) and subscribe to
  // live changes, so the layout can't desync from the window — even across a
  // dev HMR reload or if the OS clamps the resize size.
  useEffect(() => {
    void bridge?.vprFloatGetCompact?.().then((value) => setCompact(Boolean(value)));
    return bridge?.onVprFloatCompact?.(setCompact);
  }, [bridge]);

  const conversations = data?.conversations ?? [];
  // Connected apps that have no chat yet — each gets a guidance row in the
  // dropdown ("start a new session") until its first prompt arrives.
  const idleApps = useMemo(
    () => (data?.apps ?? []).filter(
      (app) => !conversations.some((chat) => conversationMatchesApp(chat.tool, app)),
    ),
    [data?.apps, conversations],
  );
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
  // Routing state: while the buyer runtime is stopped the pill shows a
  // "Not connected" status and the dropdown hides recent chats.
  const runtimeOn = data?.runtimeOn ?? true;

  // The model that served the most recent chat (its pin, set by the buyer on
  // the chat's first request) — shown on the pill face instead of the
  // default selection.
  const recentModelLabel = useMemo(() => {
    // Newest chat with a resolved pin — brand-new chats have none yet.
    const recent = conversations.find((chat) => chat.pinnedServiceId)?.pinnedServiceId;
    if (!recent) return null;
    return models.find((model) => model.serviceId === recent)?.label ?? recent;
  }, [conversations, models]);

  // The pill leads with the AntSeed identity — the badge is always the
  // AntSeed mark; model branding stays inside the dropdown rows.
  const badgeIcon = <AntStationMark size={26} />;

  if (compact) {
    return (
      <div className={styles.compactRoot}>
      <div className={styles.compactChip}>
        <div className={`${styles.chipFlip}${flipped ? ` ${styles.chipFlipped}` : ''}`}>
          {/* Front: the selected model's badge. Only the icon itself is
              clickable — the rest of the chip stays a drag handle. */}
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
                {badgeIcon}
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
      {/* The whole pill face is the dropdown trigger — badge, label and
          usage line together — and doubles as a drag handle: pointer deltas
          move the window, and only a press that never moved counts as the
          click that toggles the panel. */}
      <button
        type="button"
        className={styles.pillTrigger}
        {...pillDragHandlers}
        onClick={() => setMenuOpen(!menuOpen)}
        aria-expanded={menuOpen}
        aria-label="Usage and conversations"
        title="AntSeed"
      >
        <span className={styles.appBadge}>{badgeIcon}</span>
        <span className={styles.body}>
          <span className={styles.triggerLabel}>
            {data?.balanceLabel ?? '$0.00'}
            {/* Empty balance + paid default model: jump straight to Add
                balance. A span (not a button) — it lives inside the trigger
                button, so a real nested button would be invalid markup. */}
            {data?.needsFunds ? (
              <span
                role="button"
                tabIndex={0}
                className={styles.addBalance}
                onClick={(event) => {
                  event.stopPropagation();
                  bridge?.vprFloatAction?.({ type: 'open-deposit' });
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.stopPropagation();
                  event.preventDefault();
                  bridge?.vprFloatAction?.({ type: 'open-deposit' });
                }}
              >
                Add balance
              </span>
            ) : null}
          </span>
          <span className={styles.usage}>
            {/* Status: red when routing is stopped, steady orange while
                ready, pulsing green while traffic moves — then naming the
                model currently being routed (the newest chat's resolved
                pin). */}
            <span
              className={`${styles.statusDot}${
                runtimeOn ? (data?.trafficActive ? '' : ` ${styles.statusDotReady}`) : ` ${styles.statusDotStopped}`
              }`}
              aria-hidden="true"
            />
            {!runtimeOn ? 'Not connected' : data?.trafficActive ? (recentModelLabel ?? 'Routing...') : 'Ready'}
          </span>
        </span>
      </button>

      {/* Manage conversations: level 1 lists the default-model row plus one
          row per chat; clicking a row slides to the shared rich model list
          (same rows as the Home dropdown) with a back header. */}
      {menuOpen ? (
        <div className={styles.menuPanel} aria-label="Manage conversations" {...pillDragHandlers}>
          <OverlayScrollArea className={styles.menuScroll} contentClassName={styles.menuScrollContent}>
          {chatTarget === null ? (
            <div key="list" className={slideClass}>
              {/* Routing stopped: no chat rows — they'd read as connected. */}
              {!runtimeOn ? (
                <div className={styles.menuEmpty}>
                  Not connected — routing is stopped. Open VPR to start it.
                </div>
              ) : null}
              {/* First-run guidance only — once any chat exists the list
                  speaks for itself. */}
              {runtimeOn && conversations.length === 0 && idleApps.map((app) => (
                <div key={app.name} className={styles.menuHint}>
                  <BrandIcon name={app.name} hints={[app.displayName]} size={16} />
                  <span className={styles.menuHintText}>
                    <span className={styles.menuHintTitle}>{app.displayName} connected</span>
                    <span className={styles.menuHintMeta}>Start a new session and send your first prompt</span>
                  </span>
                </div>
              ))}
              {!runtimeOn ? null : conversations.length === 0 ? (
                idleApps.length === 0 ? <div className={styles.menuEmpty}>No tool chats seen yet</div> : null
              ) : conversations.map((chat) => {
                // Name the model the chat runs on: its pin (set by the buyer
                // on the chat's first request), falling back to the default
                // route for chats that haven't resolved a request yet.
                const pinnedLabel = chat.pinnedServiceId
                  ? (models.find((model) => model.serviceId === chat.pinnedServiceId)?.label ?? chat.pinnedServiceId)
                  : null;
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
                        <span className={styles.sessionId}>{chat.sessionShort}</span>
                        {chat.cost ? <span className={styles.menuRowCost}>{chat.cost}</span> : null}
                      </span>
                      <span className={styles.menuRowMeta}>
                        <span className={styles.menuRowMetaText}>
                          {displayToolName(chat.tool)} · {conversationAge(chat.lastActiveAt)}
                        </span>
                        <span className={styles.menuRowModel}>{pinnedLabel ?? modelLabel}</span>
                      </span>
                    </span>
                    <HugeiconsIcon icon={ArrowRight01Icon} size={14} strokeWidth={2} className={styles.menuRowChevron} />
                  </button>
                );
              })}
            </div>
          ) : (chatTarget === 'default' || targetChat) ? (
            <div key={chatTarget} className={slideClass}>
              {/* Same back-title chrome as the inner VPR pages, plus a
                  right-side shortcut launching the chat's app. */}
              <div className={styles.menuBack}>
                <VprBackTitle
                  title={targetChat ? targetChat.title : 'New session model'}
                  onBack={drillBack}
                />
                {targetChat ? (
                  <button
                    type="button"
                    className={styles.menuOpenApp}
                    onClick={() => bridge?.vprFloatAction?.({ type: 'open-chat-app', conversationId: targetChat.id })}
                    title={`Open ${displayToolName(targetChat.tool)}`}
                    aria-label={`Open ${displayToolName(targetChat.tool)}`}
                  >
                    <BrandIcon name={targetChat.tool} hints={[targetChat.tool]} size={14} />
                    <HugeiconsIcon icon={ArrowUpRight01Icon} size={12} strokeWidth={2} />
                  </button>
                ) : null}
              </div>
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
          {/* Setting, not a chat: a quiet one-liner naming the model the next
              app session starts on — pinned above the footer, list level only. */}
          {chatTarget === null ? (
            <button
              type="button"
              className={`${styles.menuRow} ${styles.menuRowDefault}`}
              onClick={() => drillIn('default')}
            >
              <span className={styles.menuRowDefaultTitle}>New session model</span>
              <span className={styles.menuRowValue}>{modelLabel}</span>
              <HugeiconsIcon icon={ArrowRight01Icon} size={14} strokeWidth={2} className={styles.menuRowChevron} />
            </button>
          ) : null}
          {/* Pinned footer: opens the main AntSeed window (VPR). */}
          <button
            type="button"
            className={styles.menuFooter}
            onClick={() => bridge?.vprFloatAction?.('open-main')}
            title="Open VPR"
          >
            <span className={styles.menuFooterLabel}>
              <AntStationMark size={14} />
              <span>Open VPR</span>
            </span>
            <HugeiconsIcon icon={ArrowUpRight01Icon} size={13} strokeWidth={2} />
          </button>
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
