import type { Command } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import { getGlobalOptions } from './types.js'
import { loadConfig, saveConfig } from '../../config/loader.js'
import { TRUSTED_PLUGINS } from '../../plugins/registry.js'
import { installPlugin } from '../../plugins/manager.js'
import type { CLIProviderConfig } from '../../config/types.js'

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Interactive setup — install trusted plugins and configure providers')
    .option('--auth-type <type>', 'auth type for providers: apikey, oauth, or claude-code', 'claude-code')
    .option('--api-key <key>', 'API key (required when auth-type is apikey)')
    .action(async (options) => {
      const globalOpts = getGlobalOptions(program)
      const config = await loadConfig(globalOpts.config)

      console.log(chalk.bold('\nAntseed — Setup\n'))

      // 1. Install plugins
      const providers = TRUSTED_PLUGINS.filter((p) => p.type === 'provider')
      const routers = TRUSTED_PLUGINS.filter((p) => p.type === 'router')

      console.log(chalk.bold('Installing plugins:\n'))

      if (providers.length > 0) {
        console.log(chalk.dim('  PROVIDERS  (for: antseed seed)'))
        for (const p of providers) {
          console.log(`    ${chalk.cyan(p.name.padEnd(16))} ${p.description}`)
        }
        console.log('')
      }

      if (routers.length > 0) {
        console.log(chalk.dim('  ROUTERS  (for: antseed connect)'))
        for (const r of routers) {
          console.log(`    ${chalk.cyan(r.name.padEnd(16))} ${r.description}`)
        }
        console.log('')
      }

      for (const plugin of TRUSTED_PLUGINS) {
        const spinner = ora(`Installing ${plugin.package}...`).start()
        try {
          await installPlugin(plugin.package)
          spinner.succeed(chalk.green(`Installed ${plugin.package}`))
        } catch (err) {
          spinner.fail(chalk.red(`Failed to install ${plugin.package}: ${(err as Error).message}`))
        }
      }

      // 2. Configure providers in the config file
      const authType = options.authType as 'apikey' | 'oauth' | 'claude-code'
      const apiKey = options.apiKey as string | undefined

      if (authType === 'apikey' && !apiKey) {
        console.log('')
        console.log(chalk.yellow('Skipping provider config — no --api-key provided.'))
        console.log(chalk.dim('  Add later: antseed config add-provider -t anthropic -k <key>'))
      } else {
        for (const plugin of providers) {
          const existing = config.providers.find(p => p.type === plugin.name)
          if (!existing) {
            const provider: CLIProviderConfig = {
              type: plugin.name,
              endpoint: 'https://api.anthropic.com',
              authHeaderName: authType === 'claude-code' ? 'authorization' : 'x-api-key',
              authValue: apiKey ?? '',
              authType,
            }
            config.providers.push(provider)
            config.seller.enabledProviders.push(plugin.name)
          } else {
            existing.authType = authType
            if (apiKey) existing.authValue = apiKey
          }
        }

        await saveConfig(globalOpts.config, config)
        console.log('')
        console.log(chalk.green(`Config saved with auth type: ${authType}`))
      }

      console.log('')
      console.log(chalk.bold('Next steps:'))
      console.log(`  ${chalk.cyan('antseed config seller set pricing.defaults.inputUsdPerMillion 12')}`)
      console.log(`  ${chalk.cyan('antseed config seller set pricing.defaults.outputUsdPerMillion 36')}`)
      console.log(`  ${chalk.cyan('antseed config buyer set maxPricing.defaults.inputUsdPerMillion 25')}`)
      console.log(`  ${chalk.cyan('antseed config buyer set maxPricing.defaults.outputUsdPerMillion 75')}`)
      console.log(`  ${chalk.cyan('antseed seed --provider anthropic')}`)
      console.log(`  ${chalk.cyan('antseed connect --router claude-code')}`)
      console.log('')
      console.log(chalk.dim('Seller settings live under seller.* and buyer preferences live under buyer.* in your config file.'))
      console.log('')
    })
}
