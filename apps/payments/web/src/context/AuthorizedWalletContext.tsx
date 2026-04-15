import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { getOperatorInfo } from '../api';
import type { PaymentConfig } from '../types';
import { AuthorizeWalletModal } from '../components/AuthorizeWalletModal';

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

type PendingAction = (() => void | Promise<void>) | null;

interface AuthorizedWalletContextValue {
  operator: string | null;
  /** null = still loading, true = authorized, false = not yet set. */
  operatorSet: boolean | null;
  refetch: () => Promise<void>;
  /**
   * Runs `action` immediately if an authorized wallet is already set.
   * Otherwise opens the authorize-wallet modal and runs `action` after the
   * user completes authorization. Pass no args to just open the modal.
   */
  requireAuthorization: (action?: () => void | Promise<void>) => void;
  bannerDismissed: boolean;
  dismissBanner: () => void;
}

const AuthorizedWalletContext = createContext<AuthorizedWalletContextValue | null>(null);

export function useAuthorizedWallet(): AuthorizedWalletContextValue {
  const ctx = useContext(AuthorizedWalletContext);
  if (!ctx) {
    throw new Error('useAuthorizedWallet must be used inside <AuthorizedWalletProvider>');
  }
  return ctx;
}

interface ProviderProps {
  config: PaymentConfig | null;
  children: ReactNode;
}

export function AuthorizedWalletProvider({ config, children }: ProviderProps) {
  const [operator, setOperator] = useState<string | null>(null);
  const [operatorSet, setOperatorSet] = useState<boolean | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const pendingActionRef = useRef<PendingAction>(null);
  const [bannerDismissed, setBannerDismissed] = useState(false);

  const refetch = useCallback(async () => {
    try {
      const info = await getOperatorInfo();
      setOperator(info.operator);
      setOperatorSet(info.operator !== ZERO_ADDR);
    } catch {
      // Keep previous state on failure.
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const requireAuthorization = useCallback(
    (action?: () => void | Promise<void>) => {
      // Block only when we know for sure no operator is set. While still
      // loading (null), fall through and run the action — the fetch on mount
      // is fast, and actions like withdraw go through the server signer.
      if (operatorSet !== false) {
        if (action) void action();
        return;
      }
      pendingActionRef.current = action ?? null;
      setModalOpen(true);
    },
    [operatorSet],
  );

  const closeModal = useCallback(() => {
    setModalOpen(false);
    pendingActionRef.current = null;
  }, []);

  const handleAuthorized = useCallback(async () => {
    await refetch();
    const pending = pendingActionRef.current;
    pendingActionRef.current = null;
    setModalOpen(false);
    if (pending) void pending();
  }, [refetch]);

  const dismissBanner = useCallback(() => setBannerDismissed(true), []);

  const value = useMemo<AuthorizedWalletContextValue>(
    () => ({
      operator,
      operatorSet,
      refetch,
      requireAuthorization,
      bannerDismissed,
      dismissBanner,
    }),
    [operator, operatorSet, refetch, requireAuthorization, bannerDismissed, dismissBanner],
  );

  return (
    <AuthorizedWalletContext.Provider value={value}>
      {children}
      <AuthorizeWalletModal
        isOpen={modalOpen}
        config={config}
        hasPendingAction={pendingActionRef.current !== null}
        onClose={closeModal}
        onAuthorized={handleAuthorized}
      />
    </AuthorizedWalletContext.Provider>
  );
}
