import type { Command } from 'commander';
import { getGlobalOptions } from './types.js';

type PortalOptions = { port: string };

async function startPaymentsPortal(program: Command, options: PortalOptions): Promise<void> {
  const port = Number(options.port) > 0 ? Number(options.port) : 3118;
  const globalOpts = getGlobalOptions(program);

  try {
    const { createServer } = await import('@antseed/payments');
    const rawHex = process.env['ANTSEED_IDENTITY_HEX'] || undefined;
    const identityHex = rawHex ? rawHex.replace(/^0x/i, '') : undefined;
    const server = await createServer({ port, dataDir: globalOpts.dataDir, identityHex });
    await server.listen({ port, host: '127.0.0.1' });

    const token = (server as unknown as { bearerToken?: string }).bearerToken ?? '';
    const url = token
      ? `http://127.0.0.1:${port}?token=${token}`
      : `http://127.0.0.1:${port}`;
    console.log(`Payments portal running at ${url}`);
    console.log('Press Ctrl+C to stop.');
  } catch (err) {
    console.error('Failed to start payments portal:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

export function registerPaymentsCommand(program: Command): void {
  const payments = program
    .command('payments')
    .description('Manage buyer payments')
    .option('-p, --port <port>', 'Portal port', '3118')
    .action(async (options: PortalOptions) => {
      await startPaymentsPortal(program, options);
    });

  payments
    .command('portal')
    .description('Launch the buyer payments portal')
    .option('-p, --port <port>', 'Portal port', '3118')
    .action(async (options: PortalOptions) => {
      await startPaymentsPortal(program, options);
    });

  payments
    .command('summary')
    .description('Show payment summary guidance')
    .action(() => {
      console.log('Payment summary is not available yet.');
      console.log('For now, use `antseed buyer balance` and `antseed buyer status`.');
    });
}
