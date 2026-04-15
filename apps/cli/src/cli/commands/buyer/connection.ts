import type { Command } from 'commander'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import chalk from 'chalk'
import { getGlobalOptions } from '../types.js'

interface BuyerStateFile {
  state: 'connected' | 'stopped'
  pid: number
  port: number
  pinnedService: string | null
  pinnedPeerId: string | null
  [key: string]: unknown
}

function stateFilePath(dataDir: string): string {
  return join(dataDir, 'buyer.state.json')
}

async function readStateFile(dataDir: string): Promise<BuyerStateFile | null> {
  try {
    const raw = await readFile(stateFilePath(dataDir), 'utf-8')
    return JSON.parse(raw) as BuyerStateFile
  } catch {
    return null
  }
}

async function writeStateFile(dataDir: string, data: BuyerStateFile): Promise<void> {
  const tmp = join(dataDir, `.buyer.state.${randomUUID()}.json.tmp`)
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2))
    await rename(tmp, stateFilePath(dataDir))
  } catch (err) {
    console.error(chalk.red(`Failed to write session state: ${err instanceof Error ? err.message : String(err)}`))
    process.exit(1)
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function requireRunningBuyer(dataDir: string): Promise<BuyerStateFile> {
  const state = await readStateFile(dataDir)
  if (!state) {
    console.error(chalk.red('No buyer connection found. Run `antseed buyer start` first.'))
    process.exit(1)
  }
  if (state.state !== 'connected' || !isProcessAlive(state.pid)) {
    console.error(chalk.red('Buyer proxy is not running. Run `antseed buyer start` first.'))
    process.exit(1)
  }
  return state
}

export function registerBuyerConnectionCommand(buyerCmd: Command): void {
  const connection = buyerCmd
    .command('connection')
    .description('Manage the active buyer connection session')

  connection
    .command('get')
    .description('Show current session state (pinned service, pinned peer)')
    .action(async () => {
      const globalOpts = getGlobalOptions(buyerCmd)
      const state = await readStateFile(globalOpts.dataDir)
      if (!state) {
        console.log(chalk.yellow('No buyer connection state found. Run `antseed buyer start` first.'))
        return
      }
      const alive = state.state === 'connected' && isProcessAlive(state.pid)
      console.log(`State:         ${alive ? chalk.green('connected') : chalk.red(state.state ?? 'stopped')}`)
      console.log(`PID:           ${state.pid}`)
      console.log(`Port:          ${state.port}`)
      console.log(`Pinned service: ${state.pinnedService ? chalk.cyan(state.pinnedService) : chalk.dim('none')}`)
      console.log(`Pinned peer:   ${state.pinnedPeerId ? chalk.cyan(state.pinnedPeerId) : chalk.dim('none')}`)
    })

  connection
    .command('set')
    .description('Update session overrides on the running buyer proxy')
    .option('--service <service>', 'override service ID for all routed requests')
    .option('--peer <peerId>', 'pin all requests to a specific peer ID (40-char hex EVM address)')
    .action(async (options) => {
      const globalOpts = getGlobalOptions(buyerCmd)
      const state = await requireRunningBuyer(globalOpts.dataDir)

      if (options.service === undefined && options.peer === undefined) {
        console.error(chalk.red('Error: specify at least --service or --peer.'))
        process.exit(1)
      }

      if (options.service !== undefined) {
        const service = String(options.service).trim()
        if (service.length === 0) {
          console.error(chalk.red('Error: --service must not be empty.'))
          process.exit(1)
        }
        state.pinnedService = service
      }

      if (options.peer !== undefined) {
        const peer = String(options.peer).trim()
        if (!/^(0x)?[0-9a-f]{40}$/i.test(peer)) {
          console.error(chalk.red('Error: --peer must be a 40-character hex peer ID (EVM address).'))
          process.exit(1)
        }
        state.pinnedPeerId = peer.toLowerCase()
      }

      await writeStateFile(globalOpts.dataDir, state)

      if (options.service !== undefined) console.log(chalk.green(`Pinned service set to: ${state.pinnedService}`))
      if (options.peer !== undefined) console.log(chalk.green(`Pinned peer set to: ${state.pinnedPeerId}`))
    })

  connection
    .command('clear')
    .description('Clear session overrides (defaults to clearing both service and peer)')
    .option('--service', 'clear only the service override')
    .option('--peer', 'clear only the peer pin')
    .action(async (options) => {
      const globalOpts = getGlobalOptions(buyerCmd)
      const state = await requireRunningBuyer(globalOpts.dataDir)

      const clearAll = !options.service && !options.peer
      const clearService = clearAll || Boolean(options.service)
      const clearPeer = clearAll || Boolean(options.peer)

      if (clearService) state.pinnedService = null
      if (clearPeer) state.pinnedPeerId = null

      await writeStateFile(globalOpts.dataDir, state)

      if (clearService && clearPeer) {
        console.log(chalk.green('All session overrides cleared.'))
      } else if (clearService) {
        console.log(chalk.green('Service override cleared.'))
      } else {
        console.log(chalk.green('Peer pin cleared.'))
      }
    })
}
