import { useEffect } from 'react';

let lockCount = 0;
let previousOverflow = '';

function lockBodyScroll() {
  if (lockCount === 0) {
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  lockCount += 1;
}

function unlockBodyScroll() {
  lockCount = Math.max(0, lockCount - 1);
  if (lockCount === 0) {
    document.body.style.overflow = previousOverflow;
    previousOverflow = '';
  }
}

export function useBodyScrollLock(isLocked: boolean) {
  useEffect(() => {
    if (!isLocked) return;
    lockBodyScroll();
    return unlockBodyScroll;
  }, [isLocked]);
}
