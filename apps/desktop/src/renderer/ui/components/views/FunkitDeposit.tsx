import { useEffect, useMemo, useState } from 'react';
import '@funkit/connect/styles.css';
import './FunkitDeposit.scss';
import {
  FunkitProvider,
  useFunkitCheckout,
  useActiveTheme,
  getDefaultChains,
  getDefaultTransports,
  darkTheme,
  lightTheme,
  type FunkitConfig,
  type FunkitCheckoutConfig,
  type FunkitWagmiConfig,
} from '@funkit/connect';
import { QueryClient } from '@tanstack/react-query';
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
  onError?: (message: string) => void;
};

// FunkitProvider only mounts its internal WagmiProvider + QueryClientProvider
// when handed both a wagmi config and a query client (plus an initialChain to
// resolve the chain id) — without them the SDK's hooks throw
// WagmiProviderNotFoundError. Module-level singletons: one config/client for
// the lifetime of the renderer, regardless of view remounts.
const funkitQueryClient = new QueryClient();
const funkitWagmiConfig: FunkitWagmiConfig = {
  chains: getDefaultChains() as FunkitWagmiConfig['chains'],
  transports: getDefaultTransports(),
  // WalletConnect is never offered (showWalletConnect is off and no extension
  // wallets exist in the desktop app), so no real WalletConnect Cloud project
  // is registered — the config just requires a non-empty id.
  projectId: 'antseed-desktop',
};

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

function DepositButton({ recipient, usdcAddress, className, onError }: Props) {
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
      Deposit
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
    <FunkitProvider
      funkitConfig={funkitConfig}
      theme={funkitTheme}
      modalSize="medium"
      locale="en"
      debug={import.meta.env.DEV}
      initialChain={8453}
      wagmiConfig={funkitWagmiConfig}
      queryClient={funkitQueryClient}
    >
      <ThemeSync mode={mode} />
      <DepositButton {...props} />
    </FunkitProvider>
  );
}
