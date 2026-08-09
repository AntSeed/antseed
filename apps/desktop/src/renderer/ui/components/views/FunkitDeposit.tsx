import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import '@funkit/connect/styles.css';
import './FunkitDeposit.scss';
import {
  FunkitProvider,
  useConnectionStatus,
  useFunkitCheckout,
  useActiveTheme,
  darkTheme,
  lightTheme,
  type FunkitConfig,
  type FunkitCheckoutConfig,
} from '@funkit/connect';
import { WagmiProvider, createConfig, http } from 'wagmi';
import { base } from 'wagmi/chains';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { activeThemeMode, type ThemeMode } from '../../lib/theme';

/**
 * Fun (fun.xyz) checkout — the primary deposit path: card/cash or a crypto
 * transfer from any chain, with the bought USDC delivered on Base to the buyer
 * hot wallet (`recipient`). The existing deposit watcher (VprDepositView)
 * sweeps arrivals into the Deposits contract — same crediting path as a QR
 * transfer, so this component only has to get funds to the wallet.
 *
 * Loaded via React.lazy: the SDK (plus its wagmi/viem peer deps — required by
 * the SDK internally, we never touch them) stays out of the main renderer
 * chunk and is fetched the first time the deposit view renders the CTA.
 */

type Props = {
  /** Fun API key — resolved by the main process (config or environment). */
  apiKey: string;
  /** Destination wallet for the purchased USDC (the buyer hot wallet). */
  recipient: string;
  /** USDC contract address on Base mainnet. */
  usdcAddress: string;
  /** Styling for the CTA button (the parent owns the look). */
  className?: string;
  /** CTA button content (the parent owns the label/logo too). */
  children?: ReactNode;
  onError?: (message: string) => void;
};

// The SDK's hooks need a WagmiProvider above them (its own is only mounted
// when handed a full FunkitWagmiConfig, which wires up the whole wallet
// connector stack — WalletConnect, MetaMask SDK, …). The desktop app never
// connects a wallet (showWalletConnect is off, no extensions exist), so we
// mount our own minimal wagmi provider instead: Base + http transport, zero
// connectors, keeping the connector code out of the bundle. Module-level
// singletons: one config/client for the renderer's lifetime.
const funkitQueryClient = new QueryClient();
const funkitWagmiConfig = createConfig({
  chains: [base],
  transports: { [base.id]: http() },
});

// Both schemes must be handed over as a set: with a single theme object the
// SDK derives light/dark for its icon assets from the OS scheme, which can
// disagree with the app's own toggle (white icons on a light surface).
// ThemeSync below picks the active scheme.
const funkitTheme = { lightTheme: lightTheme(), darkTheme: darkTheme() };

/** The Fun widget follows the app's light/dark mode (body class), not the OS. */
function useAppThemeMode(): ThemeMode {
  const [mode, setMode] = useState<ThemeMode>(() => activeThemeMode());
  useEffect(() => {
    const observer = new MutationObserver(() => setMode(activeThemeMode()));
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return mode;
}

/** Follows the app's light/dark toggle inside the provider tree. */
function ThemeSync({ mode }: { mode: ThemeMode }) {
  const { toggleTheme } = useActiveTheme();
  useEffect(() => {
    toggleTheme(mode);
  }, [mode, toggleTheme]);
  return null;
}

/**
 * Sign-in popups (main/payments/checkout-window.ts) don't produce a deposit,
 * so the deposit watcher's close-on-arrival never fires for them — the SDK's
 * connection status flipping to `connected` is that flow's success signal.
 * Payment popups are covered by the watcher when the USDC lands.
 */
function CloseCheckoutWindowsOnLogin() {
  const status = useConnectionStatus();
  const previous = useRef(status);
  useEffect(() => {
    if (status === 'connected' && previous.current !== 'connected') {
      void window.antseedDesktop?.paymentsCloseCheckoutWindows?.();
    }
    previous.current = status;
  }, [status]);
  return null;
}

function DepositButton({ recipient, usdcAddress, className, children, onError }: Props) {
  const checkoutConfig = useMemo<FunkitCheckoutConfig>(() => ({
    modalTitle: 'Deposit',
    targetChain: '8453',
    targetAsset: usdcAddress as `0x${string}`,
    targetAssetTicker: 'USDC',
    // 0 = the user picks the amount inside the widget.
    targetAssetAmount: 0,
    checkoutItemTitle: 'USDC',
    iconSrc: 'https://sdk-cdn.fun.xyz/images/usdc.svg',
    // Deliver to the hot wallet instead of a connected browser wallet — the
    // desktop app never connects one (showWalletConnect is off below).
    customRecipient: recipient as `0x${string}`,
  }), [recipient, usdcAddress]);

  const { beginCheckout } = useFunkitCheckout({
    config: checkoutConfig,
    onError: (result) => onError?.(result.message || 'Checkout failed.'),
  });

  return (
    <button type="button" className={className} onClick={() => { onError?.(''); void beginCheckout(); }}>
      {children ?? 'Deposit'}
    </button>
  );
}

export default function FunkitDeposit(props: Props) {
  const mode = useAppThemeMode();

  const funkitConfig = useMemo<FunkitConfig>(() => ({
    appName: 'AntSeed',
    apiKey: props.apiKey,
    source: 'antseed vpr',
    // Fun keys checkout state (payment methods, saved cards) to this id —
    // without it the method list comes back empty. The buyer hot wallet is
    // the user's AntSeed identity, and it's also the delivery target.
    externalUserId: props.recipient,
    uiCustomizations: {
      sourceChangeScreen: {
        // Card/cash and transfer-crypto only — wallet extensions don't exist
        // inside the desktop app.
        showWalletConnect: false,
      },
    },
  }), [props.apiKey, props.recipient]);

  return (
    <WagmiProvider config={funkitWagmiConfig}>
      <QueryClientProvider client={funkitQueryClient}>
        <FunkitProvider
          funkitConfig={funkitConfig}
          theme={funkitTheme}
          modalSize="medium"
          locale="en"
          debug={import.meta.env.DEV}
          initialChain={8453}
        >
          <ThemeSync mode={mode} />
          <CloseCheckoutWindowsOnLogin />
          <DepositButton {...props} />
        </FunkitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
