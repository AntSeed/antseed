import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { HugeiconsIcon } from '@hugeicons/react';
import { Copy01Icon, Tick02Icon } from '@hugeicons/core-free-icons';
import styles from './ChatCopyButton.module.scss';

type ChatCopyButtonProps = {
  className: string;
  copiedClassName?: string;
  text?: string;
  getText?: () => string;
  onBeforeCopy?: (text: string) => boolean;
  iconSize?: number;
  timeoutMs?: number;
  stopClickPropagation?: boolean;
  ariaLabel?: string;
  copiedAriaLabel?: string;
  tooltipLabel?: string;
  copiedTooltipLabel?: string;
};

export function ChatCopyButton({
  className,
  copiedClassName,
  text,
  getText,
  onBeforeCopy,
  iconSize = 14,
  timeoutMs = 1500,
  stopClickPropagation = false,
  ariaLabel = 'Copy',
  copiedAriaLabel = 'Copied!',
  tooltipLabel = 'Copy',
  copiedTooltipLabel = 'Copied!',
}: ChatCopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    if (stopClickPropagation) event.stopPropagation();

    const copyText = getText ? getText() : text;
    if (!copyText) return;
    if (onBeforeCopy && !onBeforeCopy(copyText)) return;

    void navigator.clipboard.writeText(copyText).then(() => {
      setCopied(true);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), timeoutMs);
    }).catch(() => {/* clipboard denied */});
  }, [getText, onBeforeCopy, stopClickPropagation, text, timeoutMs]);

  const buttonClassName = [className, copied ? copiedClassName : ''].filter(Boolean).join(' ');

  return (
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            className={buttonClassName}
            type="button"
            onClick={handleCopy}
            aria-label={copied ? copiedAriaLabel : ariaLabel}
          >
            <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} size={iconSize} color="currentColor" strokeWidth={2} />
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className={styles.tooltipContent} sideOffset={5}>
            {copied ? copiedTooltipLabel : tooltipLabel}
            <Tooltip.Arrow className={styles.tooltipArrow} />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
