import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from './AppShell';
import { setActiveView, setEarningsPeriod } from './state/ui-shell-store';

vi.mock('./app', () => ({}));

describe('AppShell integration', () => {
  beforeEach(() => {
    delete (window as { __antseedRendererInitialized?: boolean }).__antseedRendererInitialized;
    setActiveView('chat');
    setEarningsPeriod('month');
  });

  it('renders buyer-only navigation and status chip', async () => {
    const { container } = render(<AppShell />);

    const sellerModeToggle = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Seller Mode'));
    const sellerBadge = container.querySelector('#seedBadge');
    const buyerBadge = container.querySelector('#connectBadge');

    await waitFor(() => {
      expect(sellerModeToggle).toBeUndefined();
      expect(sellerBadge).toBeNull();
      expect(buyerBadge).not.toBeNull();
    });
  });
});
