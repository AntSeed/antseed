import type { Command } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import { getGlobalOptions } from '../types.js'
import { CAManager } from '../../../system-proxy/ca-manager.js'
import { hookPath } from '../../../system-proxy/node-hook.js'

export function registerSystemProxyInstallCaCommand(cmd: Command): void {
  cmd
    .command('install-ca')
    .description('Generate (if needed) and install the local CA certificate into the OS trust store')
    .action(async () => {
      const globalOpts = getGlobalOptions(cmd)
      const caManager = new CAManager(globalOpts.dataDir)

      if (!(await caManager.exists())) {
        const genSpinner = ora('Generating CA certificate...').start()
        await caManager.generate()
        genSpinner.succeed(chalk.green('CA certificate generated'))
      } else {
        console.log(chalk.dim('CA certificate already exists, using existing.'))
      }

      const installSpinner = ora('Installing CA into system trust store...').start()
      try {
        const result = await caManager.installToSystemKeychain()
        installSpinner.succeed(chalk.green(`CA certificate installed (${result.target})`))
        if (result.warning) {
          console.log(chalk.yellow(`Warning: ${result.warning}`))
        }
      } catch (err) {
        installSpinner.fail(chalk.red(`Install failed: ${(err as Error).message}`))
        console.log(chalk.yellow('\nTry manually trusting the certificate:'))
        console.log(`  ${caManager.certFilePath}`)
        process.exit(1)
      }

      console.log('')
      console.log(chalk.bold('For Node.js tools also add to your shell:'))
      console.log(`  export NODE_EXTRA_CA_CERTS="${caManager.certFilePath}"`)
      console.log(`  export NODE_OPTIONS="--require ${hookPath(globalOpts.dataDir)}"`)
      console.log('')
      console.log(chalk.dim('Add those lines to ~/.zshrc or ~/.bashrc to make them permanent, then restart the tool.'))
    })
}
