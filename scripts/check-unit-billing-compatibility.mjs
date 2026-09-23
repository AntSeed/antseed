import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Wallet } from 'ethers';
import { serviceBillingOffering, COMPLETED_REQUESTS_CAPABILITY } from '../packages/protocol/dist/service-billing.js';
import { signData, verifySignature } from '../packages/protocol/dist/signing.js';
import { encodeMetadata, encodeMetadataForSigning } from '../packages/node/dist/discovery/metadata-codec.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseline = '172e4fc986484c9c1adbbfccd076427850dd57c7';
const temporary = await mkdtemp(join(tmpdir(), 'antseed-unit-billing-legacy-'));
const source = file => execFileSync('git', ['show', `${baseline}:${file}`], { cwd: root, encoding: 'utf8' });

async function legacyModule(file) {
  const outfile = join(temporary, `${posix.basename(file, '.ts')}.mjs`);
  await build({
    entryPoints: [file], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
    plugins: [{
      name: 'frozen-source',
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => {
          if (args.kind === 'entry-point') return { path: args.path, namespace: 'legacy' };
          if (args.path.startsWith('.')) return { path: posix.normalize(posix.join(posix.dirname(args.importer), args.path)).replace(/\.js$/, '.ts'), namespace: 'legacy' };
          const match = /^@antseed\/(protocol|api-adapter|buyer-core)(?:\/(.*))?$/.exec(args.path);
          if (match) return { path: `packages/${match[1]}/src/${match[2] ?? 'index'}.ts`, namespace: 'legacy' };
          return { path: args.path, external: true };
        });
        builder.onLoad({ filter: /.*/, namespace: 'legacy' }, args => ({ contents: source(args.path), loader: 'ts' }));
      },
    }],
  });
  return import(pathToFileURL(outfile).href);
}

try {
  await symlink(join(root, 'node_modules'), join(temporary, 'node_modules'), 'dir');
  const codec = await legacyModule('packages/node/src/discovery/metadata-codec.ts');
  const validator = await legacyModule('packages/node/src/discovery/metadata-validator.ts');
  const { BuyerRequestHandler } = await legacyModule('packages/buyer-core/src/buyer-request-handler.ts');
  const units = await legacyModule('packages/buyer-core/src/unit-billing.ts');
  const wallet = Wallet.createRandom();
  const imageModel = { version: 1, components: [{ unit: 'output_images', priceUsd: 0.04 }] };
  const pricing = { inputUsdPerMillion: 0, outputUsdPerMillion: 0 };
  const metadata = {
    version: 12, peerId: wallet.address.slice(2).toLowerCase(), region: 'us', timestamp: Date.now(), signature: '',
    providers: [{ provider: 'openai', services: ['image'], defaultPricing: pricing, maxConcurrency: 5, currentLoad: 0,
      serviceApiProtocols: { image: ['openai-images'] }, serviceUnitBillingModels: { image: { 'openai-images': imageModel } } }],
    capabilities: [COMPLETED_REQUESTS_CAPABILITY],
    offerings: [serviceBillingOffering({ provider: 'levanto', service: 'levanto-route', serviceApiProtocol: 'levanto-routing', priceMicroUsdc: '1000' })],
  };
  metadata.signature = Buffer.from(signData(wallet, encodeMetadataForSigning(metadata))).toString('hex');
  const decoded = codec.decodeMetadata(encodeMetadata(metadata));
  assert.deepEqual(validator.validateMetadata(decoded), []);
  assert.equal(await verifySignature(decoded.peerId, Buffer.from(decoded.signature, 'hex'), codec.encodeMetadataForSigning(decoded)), true);
  assert.deepEqual(decoded.providers[0].services, ['image']);
  assert.equal(decoded.providers[0].serviceUnitBillingModels.image['openai-images'].version, 1);
  assert.deepEqual(Buffer.from(codec.encodeMetadata(decoded)), Buffer.from(encodeMetadata(metadata)));

  const peer = {
    peerId: decoded.peerId, providers: ['openai'], metadata: decoded, lastSeen: Date.now(),
    providerPricing: { openai: { defaults: pricing } },
    providerServiceApiProtocols: { openai: { services: { image: ['openai-images'] } } },
    providerServiceUnitBillingModels: { openai: { services: decoded.providers[0].serviceUnitBillingModels } },
  };
  const request = {
    requestId: 'legacy-image', method: 'POST', path: '/v1/images/generations', headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ model: 'image', prompt: 'A tree', n: 2 })),
  };
  let captured;
  let result;
  let sent = 0;
  const handler = new BuyerRequestHandler({}, {
    localPeerId: 'b'.repeat(40), verificationStorage: null, verificationSampler: null,
    getConnection: async () => ({ state: 'open' }),
    getMux: () => ({
      cancelProxyRequest() {},
      sendProxyRequest(outgoing, onResponse) {
        sent += 1;
        assert.equal(outgoing.headers['x-antseed-service-contract'], undefined);
        onResponse({ requestId: outgoing.requestId, statusCode: 200, headers: {},
          body: Buffer.from(JSON.stringify({ data: [{ url: 'https://example.test/image-1' }, { url: 'https://example.test/image-2' }] })) }, { streamingStart: false });
      },
    }),
    getVerificationMux: () => ({}), registerPaymentMux() {},
    negotiator: {
      getOrCreatePaymentMux: () => ({}),
      trackRequestBillingContext(outgoing, service) {
        captured = units.captureUnitBillingContext({ sellerPeerId: peer.peerId, provider: 'openai', service, serviceApiProtocol: 'openai-images', request: outgoing });
      },
      estimateCostFromResponse(_peer, response) {
        result = units.computeFinalUnitBilling(imageModel, captured.context, response, captured.requestFacts);
      },
    },
  });
  assert.equal((await handler.sendRequest(peer, request)).statusCode, 200);
  assert.equal(sent, 1);
  assert.equal(result.costUsdc, 80_000n);
  assert.deepEqual(result.billingUsage, { version: 1, units: { output_images: '2' } });
  decoded.offerings[0].pricing.pricePerUnit = 1;
  assert.equal(await verifySignature(decoded.peerId, Buffer.from(decoded.signature, 'hex'), codec.encodeMetadataForSigning(decoded)), false);
  console.log(`PASS: frozen ${baseline.slice(0, 9)} metadata decode/signature and legacy image-request fixture; 2 images = 80000 micro-USDC, unchanged v1 usage report.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
