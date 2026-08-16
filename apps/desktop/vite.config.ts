import path from 'node:path';
import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

const rendererRoot = path.resolve(__dirname, 'src/renderer');
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'));

// Browser-wallet SDKs lazily imported by wagmi's connector factories. The
// desktop app never connects a browser wallet (the Fun checkout runs with
// zero connectors), so these resolve to an empty stub — dropping ~7 MB of
// never-loaded chunks from the renderer bundle. See wallet-sdk-stub.ts.
const walletSdkStub = path.resolve(rendererRoot, 'wallet-sdk-stub.ts');
const stubbedWalletSdks = [
  '@base-org/account',
  '@coinbase/wallet-sdk',
  '@metamask/sdk',
  '@safe-global/safe-apps-provider',
  '@safe-global/safe-apps-sdk',
  '@walletconnect/ethereum-provider',
  'cbw-sdk',
  'porto',
];

export default defineConfig(({ mode }) => {
  // Fun (fun.xyz) API key baked into the renderer at build time so packaged
  // installs ship with the deposit CTA enabled. Deliberately NOT in the
  // source tree: release builds get it from the ANTSEED_FUNKIT_API_KEY
  // environment variable (CI: repo secret; local: apps/desktop/.env, which
  // loadEnv reads). Empty when absent — the CTA then hides, and a runtime
  // key in config.payments.funkit.apiKey still overrides the baked one.
  const fileEnv = loadEnv(mode, __dirname, '');
  const funkitApiKey = process.env.ANTSEED_FUNKIT_API_KEY ?? fileEnv.ANTSEED_FUNKIT_API_KEY ?? '';
  const rendererPort = Number(process.env.ANTSEED_DESKTOP_RENDERER_PORT) || 5174;
  const systemProxyPort = Number(process.env.ANTSEED_SYSTEM_PROXY_PORT) || 8378;

  return {
  plugins: [react()],
  base: './',
  root: rendererRoot,
  resolve: {
    // Regex form so package subpath imports (e.g. porto/internal) stub too.
    alias: stubbedWalletSdks.map((sdk) => ({
      find: new RegExp(`^${sdk.replace(/[/\\^$.*+?()[\]{}|]/g, '\\$&')}(/.*)?$`),
      replacement: walletSdkStub,
    })),
  },
  build: {
    outDir: path.resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: path.resolve(rendererRoot, 'index.html'),
        // Detachable always-on-top pill window (see src/main/window.ts).
        float: path.resolve(rendererRoot, 'float.html'),
        // macOS menu-bar VPR model picker popover.
        menuBar: path.resolve(rendererRoot, 'menu-bar.html'),
      },
    },
  },
  css: {
    modules: {
      localsConvention: 'camelCaseOnly'
    }
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __FUNKIT_API_KEY__: JSON.stringify(funkitApiKey),
    __ANTSEED_SYSTEM_PROXY_PORT__: JSON.stringify(systemProxyPort),
  },
  server: {
    host: '127.0.0.1',
    port: rendererPort,
    strictPort: true,
  },
  };
});
