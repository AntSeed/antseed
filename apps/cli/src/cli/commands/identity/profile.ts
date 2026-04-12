import type { Command } from 'commander';
import chalk from 'chalk';

/**
 * Register the `antseed profile` command and its subcommands.
 */
export function registerProfileCommand(program: Command): void {
  const profile = program
    .command('profile')
    .description('Manage your peer profile');

  profile
    .command('show')
    .description('Display your current profile')
    .action(async () => {
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const { homedir } = await import('node:os');

      const profilePath = join(homedir(), '.antseed', 'profile.json');
      try {
        const data = await readFile(profilePath, 'utf-8');
        const prof = JSON.parse(data);
        console.log(chalk.bold('Peer Profile'));
        console.log(chalk.dim('\u2500'.repeat(40)));
        console.log(`  Name:         ${chalk.cyan(prof.displayName)}`);
        console.log(`  Description:  ${prof.description}`);
        console.log(`  Tags:         ${(prof.tags || []).join(', ')}`);
        console.log(`  Capabilities: ${(prof.capabilities || []).join(', ')}`);
        console.log(`  Region:       ${prof.region}`);
        console.log(`  Languages:    ${(prof.languages || []).join(', ')}`);
        if (prof.website) console.log(`  Website:      ${prof.website}`);
        console.log(`  Created:      ${new Date(prof.createdAt).toISOString()}`);
        console.log(`  Updated:      ${new Date(prof.updatedAt).toISOString()}`);
      } catch {
        console.log(chalk.yellow('No profile found. Use "antseed profile set" to create one.'));
      }
    });

  profile
    .command('set')
    .description('Create or update your profile')
    .requiredOption('--name <name>', 'Display name')
    .option('--description <desc>', 'Description of what you offer', '')
    .option('--tags <tags>', 'Comma-separated tags', '')
    .option('--capabilities <caps>', 'Comma-separated capabilities (inference,agent,skill,tool)', 'inference')
    .option('--region <region>', 'Region', 'unknown')
    .option('--languages <langs>', 'Comma-separated languages', 'en')
    .option('--website <url>', 'Website URL')
    .action(async (options) => {
      const { writeFile, mkdir, readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const { homedir } = await import('node:os');

      const dir = join(homedir(), '.antseed');
      await mkdir(dir, { recursive: true });
      const profilePath = join(dir, 'profile.json');

      let existing: Record<string, unknown> = {};
      try {
        existing = JSON.parse(await readFile(profilePath, 'utf-8'));
      } catch {}

      const now = Date.now();
      const prof = {
        ...existing,
        displayName: options.name,
        description: options.description || existing.description || '',
        tags: options.tags ? options.tags.split(',').map((t: string) => t.trim()) : existing.tags || [],
        capabilities: options.capabilities.split(',').map((c: string) => c.trim()),
        region: options.region,
        languages: options.languages.split(',').map((l: string) => l.trim()),
        website: options.website || existing.website,
        createdAt: existing.createdAt || now,
        updatedAt: now,
      };

      await writeFile(profilePath, JSON.stringify(prof, null, 2));
      console.log(chalk.green('Profile saved successfully.'));
    });
}

/**
 * Register the `antseed peer <peerId>` command.
 */
export function registerPeerCommand(program: Command): void {
  program
    .command('peer')
    .description('View a peer\'s profile')
    .argument('<peerId>', 'Peer ID (hex)')
    .action(async (peerId: string) => {
      console.log(chalk.bold(`Peer: ${peerId.slice(0, 16)}...`));
      console.log(chalk.yellow('Connect to the network first to view peer details.'));
    });
}
