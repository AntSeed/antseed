import type { Command } from 'commander';
import chalk from 'chalk';
import { getGlobalOptions } from './types.js';
import { openSessionStore } from '../payment-utils.js';
import type { StoredSession } from '@antseed/node';

/** Abbreviate a session/peer ID to a short form. */
function short(id: string, len = 10): string {
  return id.length > len ? id.slice(0, len) + '...' : id;
}

function statusColor(status: string): string {
  switch (status) {
    case 'active': return chalk.green(status);
    case 'settled': return chalk.cyan(status);
    case 'timeout': return chalk.yellow(status);
    case 'ghost': return chalk.red(status);
    default: return status;
  }
}

export function registerSessionsCommand(program: Command): void {
  program
    .command('sessions')
    .description('List payment sessions from local store')
    .option('--status <status>', 'filter by status: active, settled, timeout, ghost')
    .option('--role <role>', 'filter by role: buyer or seller')
    .option('--limit <number>', 'max number of sessions to show', '20')
    .option('--json', 'output as JSON', false)
    .action(async (options) => {
      const globalOpts = getGlobalOptions(program);

      let store;
      try {
        store = openSessionStore(globalOpts.dataDir);
      } catch (err) {
        console.error(chalk.red(`Failed to open session store: ${(err as Error).message}`));
        console.error(chalk.dim('Have you connected to the network yet? Sessions are stored locally after first use.'));
        process.exit(1);
      }

      try {
        // Query sessions — SessionStore doesn't have a generic list method,
        // so we use the DB directly via the available methods.
        // For now, we read from the active/timeout sessions.
        const limit = parseInt(options.limit as string, 10) || 20;
        const statusFilter = options.status as string | undefined;
        const roleFilter = options.role as string | undefined;

        const allSessions = store.listAllSessions(limit * 2);

        // Apply filters
        let filtered = allSessions;
        if (statusFilter) {
          filtered = filtered.filter(s => s.status === statusFilter);
        }
        if (roleFilter) {
          filtered = filtered.filter(s => s.role === roleFilter);
        }

        // Sort by most recent first
        filtered.sort((a, b) => b.updatedAt - a.updatedAt);
        const limited = filtered.slice(0, limit);

        if (options.json) {
          console.log(JSON.stringify(limited, null, 2));
          return;
        }

        if (limited.length === 0) {
          console.log(chalk.yellow('No sessions found.'));
          return;
        }

        console.log(chalk.bold(`Payment Sessions (${limited.length} of ${filtered.length}):\n`));

        for (const session of limited) {
          console.log(`  ${chalk.bold(short(session.sessionId, 16))}  ${statusColor(session.status)}  ${chalk.dim(session.role)}`);
          console.log(`    Peer: ${chalk.dim(short(session.peerId, 16))}  Requests: ${session.requestCount}  Tokens: ${session.tokensDelivered}`);
          console.log(`    Created: ${chalk.dim(new Date(session.createdAt).toISOString())}`);
          if (session.settledAt) {
            console.log(`    Settled: ${chalk.dim(new Date(session.settledAt).toISOString())}  Amount: ${session.settledAmount ?? 'N/A'}`);
          }
          console.log('');
        }
      } finally {
        store.close();
      }
    });
}
