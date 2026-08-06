import path from 'node:path';
import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

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

export default defineConfig({
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
  },
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
  },
});
