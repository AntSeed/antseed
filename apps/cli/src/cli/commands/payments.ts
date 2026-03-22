import type { Command } from 'commander';

export function registerPaymentsCommand(program: Command): void {
  program
    .command('payments')
    .description('Launch the buyer payments portal')
    .option('-p, --port <port>', 'Portal port', '3118')
    .action(async (options: { port: string }) => {
      const port = Number(options.port) > 0 ? Number(options.port) : 3118;

      try {
        const { createServer } = await import('@antseed/payments');
        const identityHex = process.env['ANTSEED_IDENTITY_HEX'] || undefined;
        const server = await createServer({ port, identityHex });
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
    });
}
