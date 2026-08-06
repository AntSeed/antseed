/**
 * The payments portal: a local server for the wallet-signing pages, and the
 * windows that show them.
 *
 * Anything that needs the user's wallet has to leave the app — extensions and
 * WalletConnect only work in a real browser — so a pay page opens in the
 * user's default browser or, failing that, a plain Electron popup (which
 * closes itself once the payment lands).
 */
import { app, BrowserWindow, shell } from 'electron';
import { createServer as createPaymentsServer } from '@antseed/payments';
import { LOCALHOST, LOCALHOST_URL } from '../constants.js';
import { ACTIVE_CONFIG_PATH } from '../runtime/active-config.js';
import { readConfig } from '../runtime/config-io.js';
import { ensureSecureIdentity, secureIdentityEnv } from '../identity.js';
import { getMainWindow } from '../ui/window.js';
import { asRecord, asString } from '../utils.js';

export let paymentsServer: Awaited<ReturnType<typeof createPaymentsServer>> | null = null;
export const PAYMENTS_PORT = Number(process.env['ANTSEED_PAYMENTS_PORT']) || 3118;

export function focusMainWindow(): void {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  app.focus({ steal: true });
  win.focus();
}

export async function startPaymentsPortal(): Promise<void> {
  if (paymentsServer) return;
  try {
    await ensureSecureIdentity();
    const identityHex = secureIdentityEnv().ANTSEED_IDENTITY_HEX;
    paymentsServer = await createPaymentsServer({
      port: PAYMENTS_PORT,
      identityHex,
      onPaymentCompleted: () => {
        // The payment landed in the browser — pull the app back up and let
        // the renderer refresh balances/channels/rewards immediately.
        focusMainWindow();
        getMainWindow()?.webContents.send('payments:completed');
      },
    });
    await paymentsServer.listen({ port: PAYMENTS_PORT, host: LOCALHOST });
    console.log(`[desktop] Payments portal running at ${LOCALHOST_URL}:${PAYMENTS_PORT}`);
  } catch (err) {
    console.error('[desktop] Failed to start payments portal:', err instanceof Error ? err.message : String(err));
    paymentsServer = null;
  }
}

export async function stopPaymentsPortal(): Promise<void> {
  if (!paymentsServer) return;
  try {
    await paymentsServer.close();
  } catch {
    // Already closed
  }
  paymentsServer = null;
}

export type PayPageKind = 'deposit' | 'withdraw' | 'authorize' | 'claim' | 'diem' | 'close-channel';
export const PAY_PAGE_KINDS: readonly PayPageKind[] = ['deposit', 'withdraw', 'authorize', 'claim', 'diem', 'close-channel'];

export let paymentsPopup: BrowserWindow | null = null;

export function openPaymentsPopup(url: string): void {
  if (paymentsPopup && !paymentsPopup.isDestroyed()) {
    void paymentsPopup.loadURL(url);
    paymentsPopup.focus();
    return;
  }
  const parent = getMainWindow();
  paymentsPopup = new BrowserWindow({
    width: 480,
    height: 800,
    minWidth: 420,
    minHeight: 620,
    ...(parent ? { parent } : {}),
    title: 'AntSeed — Secure payment',
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  paymentsPopup.setMenuBarVisibility(false);
  // Wallet deep links and explorer links leave the popup for the system
  // browser; the popup stays on the payment page only.
  paymentsPopup.webContents.setWindowOpenHandler(({ url: external }) => {
    void shell.openExternal(external);
    return { action: 'deny' };
  });
  paymentsPopup.on('closed', () => {
    paymentsPopup = null;
    focusMainWindow();
  });
  void paymentsPopup.loadURL(url);
}



// Card payments open a hosted checkout page. USDC bought with a card is
// delivered on Base to the buyer hot wallet and credited into AntseedDeposits
// via the P2P deposit relay — same path as a direct QR transfer.
//
// Providers come from config (payments.card.providers) as HTTPS URL templates
// with {address} and optional {amount} placeholders. The default is AntSeed's
// hosted card page, which handles the Coinbase Onramp session server-side so
// the CDP secret key never ships inside the app.
export type CardProvider = { id: string; label: string; url: string };

export const DEFAULT_CARD_PROVIDERS: CardProvider[] = [
  { id: 'meridian', label: 'Meridian', url: 'https://antseed.mrdn.finance/?buyer={address}' },
  { id: 'antseed-pay', label: 'AntSeed Pay', url: 'https://antseed-pay.com/' },
];

// A configured empty array is respected (zero providers = card disabled);
// only a missing/invalid config falls back to the built-in default.
export async function readCardProviders(): Promise<CardProvider[]> {
  let entries: unknown;
  try {
    const config = await readConfig(ACTIVE_CONFIG_PATH);
    entries = asRecord(asRecord(config.payments).card).providers;
  } catch {
    return DEFAULT_CARD_PROVIDERS;
  }
  if (!Array.isArray(entries)) return DEFAULT_CARD_PROVIDERS;
  const providers: CardProvider[] = [];
  for (const entry of entries) {
    const record = asRecord(entry);
    const id = asString(record.id as string, '');
    const label = asString(record.label as string, '');
    const url = asString(record.url as string, '');
    if (id && label && url) providers.push({ id, label, url });
  }
  return providers;
}



// Crossmint Stablecoin Onramp — in-app embedded checkout for buying USDC on
// Base with a card, delivered to the buyer hot wallet (then swept into
// deposits by the same watcher as QR/card transfers). The client-side key is
// public by design: it ships in the app and is origin-restricted in the
// Crossmint console, exactly like DEFAULT_CARD_PROVIDERS embeds AntSeed's
// hosted URL. Overridable via config.payments.crossmint.clientKey.
export const DEFAULT_CROSSMINT_CLIENT_KEY = 'ck_production_ABDYKwqzx1t6ZCbkVTyWGUMQvnARXTXHMkjgQY5LS7TFy81sDDQnRez9aY3ogznqmWM4uQ7PuUzm9S4Tj7WxPdFj1Rj5BEzZJB9sSErLxC7qmKrPFPBvhqsYCvWL6wHfzWQqtekvcXUZhuFCiWHcRALx4UsZdTZ7MHb11xCesc56WizPx9o6BKtLqA9yQhcLppJX3sYngJPn7sBCT6n9sqHt';

export function crossmintApiBase(clientKey: string): string {
  return clientKey.startsWith('ck_staging_') ? 'https://staging.crossmint.com' : 'https://www.crossmint.com';
}

export async function readCrossmintClientKey(): Promise<string> {
  try {
    const config = await readConfig(ACTIVE_CONFIG_PATH);
    const key = asString(asRecord(asRecord(config.payments).crossmint).clientKey as string, '');
    return key || DEFAULT_CROSSMINT_CLIENT_KEY;
  } catch {
    return DEFAULT_CROSSMINT_CLIENT_KEY;
  }
}

// Fun (fun.xyz) checkout — the primary in-app deposit flow: card/cash or a
// crypto transfer, with the bought USDC delivered on Base to the buyer hot
// wallet (then swept into deposits by the same watcher as QR/card transfers).
// The API key is deliberately NOT in the source tree: it comes from
// config.payments.funkit.apiKey, or the ANTSEED_FUNKIT_API_KEY environment
// variable. An empty key hides the Fun deposit CTA entirely.
export async function readFunkitApiKey(): Promise<string> {
  try {
    const config = await readConfig(ACTIVE_CONFIG_PATH);
    const key = asString(asRecord(asRecord(config.payments).funkit).apiKey as string, '');
    if (key) return key;
  } catch {
    // fall through to the environment
  }
  return process.env.ANTSEED_FUNKIT_API_KEY ?? '';
}

// GoodDollar AI-credits checkout — a hosted page built by the GoodDollar team
// where users buy credits with G$. The page is handed the buyer address plus
// an EIP-712 SetOperator signature authorizing GoodDollar's operator wallet,
// which lets their side submit setOperator() and manage the deposit on the
// buyer's behalf (the buyer never pays gas). Overridable via
// config.payments.gooddollar.{url,operator}.
export const DEFAULT_GOODDOLLAR_URL = 'https://aicredits.gooddollar.org/';
export const DEFAULT_GOODDOLLAR_OPERATOR = '0x192288D921045aa96903e5286E116960e5fb4607';

export async function readGoodDollarConfig(): Promise<{ url: string; operator: string }> {
  try {
    const config = await readConfig(ACTIVE_CONFIG_PATH);
    const record = asRecord(asRecord(config.payments).gooddollar);
    return {
      url: asString(record.url as string, '') || DEFAULT_GOODDOLLAR_URL,
      operator: asString(record.operator as string, '') || DEFAULT_GOODDOLLAR_OPERATOR,
    };
  } catch {
    return { url: DEFAULT_GOODDOLLAR_URL, operator: DEFAULT_GOODDOLLAR_OPERATOR };
  }
}


/**
 * Bearer token the portal server expects on its pages. Empty until
 * `startPaymentsPortal()` has run.
 */
export function getPaymentsPortalToken(): string {
  return paymentsServer ? (paymentsServer as unknown as { bearerToken?: string }).bearerToken ?? '' : '';
}
