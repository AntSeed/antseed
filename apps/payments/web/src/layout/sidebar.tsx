import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Analytics02Icon,
  ArrowDataTransferHorizontalIcon,
  Plant01Icon,
} from '@hugeicons/core-free-icons';
import type { BalanceData, PaymentConfig } from '../types';
import { AntSeedLogo } from '../components/ui/ant-seed-logo';
import { AccountMenu, SidebarAuthWarning } from './account-menu';

export const TAB_IDS = ['overview', 'channels', 'earn', 'emissions', 'diem-rewards'] as const;
export type TabId = typeof TAB_IDS[number];

interface SidebarProps {
  activeTab: TabId;
  onSelect: (tab: TabId) => void;
  isDark: boolean;
  onToggleTheme: () => void;
  config: PaymentConfig | null;
  balance: BalanceData | null;
  buyerEvmAddress: string | null;
  onOpenDeposit: () => void;
  onOpenWithdraw: () => void;
}

interface NavItem {
  id: TabId;
  label: string;
  icon: ReactNode;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'overview', label: 'Overview', icon: <HugeiconsIcon icon={Analytics02Icon} size={18} strokeWidth={1.5} /> },
  { id: 'channels',  label: 'Channels',  icon: <HugeiconsIcon icon={ArrowDataTransferHorizontalIcon} size={18} strokeWidth={1.5} /> },
  { id: 'earn', label: 'Earn', icon: <HugeiconsIcon icon={Plant01Icon} size={18} strokeWidth={1.5} /> },
];

function AlphaHint() {
  const [open, setOpen] = useState(false);
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties>({});
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      const target = e.target as Node;
      if (wrapRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    function updatePosition() {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      setPopoverStyle({
        position: 'fixed',
        top: rect.bottom + 8,
        left: rect.left,
      });
    }
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open]);

  const popover = open ? (
    <div
      ref={popoverRef}
      className="dash-sidebar-alpha-popover"
      role="dialog"
      aria-label="About this alpha build"
      style={popoverStyle}
    >
      <div className="dash-sidebar-alpha-popover-head">
        <span className="dash-sidebar-alpha-popover-dot" aria-hidden="true" />
        <span className="dash-sidebar-alpha-popover-eyebrow">Alpha build</span>
      </div>
      <p className="dash-sidebar-alpha-popover-lede">
        The AntSeed payments portal is under active development. Numbers and flows may change.
      </p>
      <ul className="dash-sidebar-alpha-popover-list">
        <li><span className="dash-sidebar-alpha-popover-mark" />Channel mechanics are evolving</li>
        <li><span className="dash-sidebar-alpha-popover-mark" />$ANTS emissions are pre-mainnet</li>
        <li><span className="dash-sidebar-alpha-popover-mark" />Expect occasional rough edges</li>
      </ul>
    </div>
  ) : null;

  return (
    <div className="dash-sidebar-alpha-wrap" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`dash-sidebar-alpha${open ? ' dash-sidebar-alpha--open' : ''}`}
        onClick={() => setOpen((p) => !p)}
        aria-label="About this alpha build"
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        Alpha
      </button>
      {popover && createPortal(popover, document.body)}
    </div>
  );
}

export function Sidebar({
  activeTab,
  onSelect,
  isDark,
  onToggleTheme,
  config,
  balance,
  buyerEvmAddress,
  onOpenDeposit,
  onOpenWithdraw,
}: SidebarProps) {
  return (
    <aside className="dash-sidebar">
      <div className="dash-sidebar-header">
        <AntSeedLogo height={28} className="dash-sidebar-logo" />
        <AlphaHint />
      </div>

      <nav className="dash-sidebar-nav" aria-label="Payments navigation">
        {NAV_ITEMS.map((item) => {
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              className={`dash-sidebar-item${isActive ? ' dash-sidebar-item--active' : ''}`}
              aria-current={isActive ? 'page' : undefined}
              onClick={() => onSelect(item.id)}
            >
              <span className="dash-sidebar-item-icon">{item.icon}</span>
              <span className="dash-sidebar-item-label">{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="dash-sidebar-footer">
        <SidebarAuthWarning />
        <AccountMenu
          config={config}
          balance={balance}
          buyerEvmAddress={buyerEvmAddress}
          isDark={isDark}
          onToggleTheme={onToggleTheme}
          onOpenDeposit={onOpenDeposit}
          onOpenWithdraw={onOpenWithdraw}
        />
      </div>
    </aside>
  );
}
