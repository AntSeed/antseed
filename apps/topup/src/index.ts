import { loadConfig } from './config.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const { fastify, service, chain } = createServer(config);

  // One-time max approval so each relayed deposit is a single transaction,
  // then reconcile any top-ups interrupted by a previous shutdown.
  await chain.ensureAllowance();
  await service.recover();

  await fastify.listen({ port: config.port, host: config.host });
  console.log(
    `[topup] listening on http://${config.host}:${config.port} ` +
      `(chain ${config.chain.chainId}, x402 network ${config.meridian.network}, relayer ${chain.relayerAddress})`,
  );

  const shutdown = async () => {
    await fastify.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[topup] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
