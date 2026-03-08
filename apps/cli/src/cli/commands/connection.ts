import type { Command } from 'commander'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import chalk from 'chalk'

const BUYER_STATE_FILE = join(homedir(), '.antseed', 'buyer.state.json')

interface BuyerStateFile {
  state: 'connected' | 'stopped'
  pid: number
  port: number
  pinnedModel: string | null
  pinnedPeerId: string | null
  [key: string]: unknown
}

async function readStateFile(): Promise<BuyerStateFile | null> {
  try {
    const raw = await readFile(BUYER_STATE_FILE, 'utf-8')
    return JSON.parse(raw) as BuyerStateFile
  } catch {
    return null
  }
}

async function writeStateFile(data: BuyerStateFile): Promise<void> {
  try {
    await writeFile(BUYER_STATE_FILE, JSON.stringify(data, null, 2))
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

async function requireRunningBuyer(): Promise<BuyerStateFile> {
  const state = await readStateFile()
  if (!state) {
    console.error(chalk.red('No buyer connection found. Run `antseed connect` first.'))
    process.exit(1)
  }
  if (state.state !== 'connected' || !isProcessAlive(state.pid)) {
    console.error(chalk.red('Buyer proxy is not running. Run `antseed connect` first.'))
    process.exit(1)
  }
  return state
}

export function registerConnectionCommand(program: Command): void {
  const connection = program
    .command('connection')
    .description('Manage the active buyer connection session')

  connection
    .command('get')
    .description('Show current session state (pinned model, pinned peer)')
    .action(async () => {
      const state = await readStateFile()
      if (!state) {
        console.log(chalk.yellow('No buyer connection state found. Run `antseed connect` first.'))
        return
      }
      const alive = state.state === 'connected' && isProcessAlive(state.pid)
      console.log(`State:         ${alive ? chalk.green('connected') : chalk.red(state.state ?? 'stopped')}`)
      console.log(`PID:           ${state.pid}`)
      console.log(`Port:          ${state.port}`)
      console.log(`Pinned model:  ${state.pinnedModel ? chalk.cyan(state.pinnedModel) : chalk.dim('none')}`)
      console.log(`Pinned peer:   ${state.pinnedPeerId ? chalk.cyan(state.pinnedPeerId) : chalk.dim('none')}`)
    })

  connection
    .command('set')
    .description('Update session overrides on the running buyer proxy')
    .option('--model <model>', 'override model ID for all routed requests')
    .option('--peer <peerId>', 'pin all requests to a specific peer ID (64-char hex)')
    .action(async (options) => {
      const state = await requireRunningBuyer()

      if (options.model === undefined && options.peer === undefined) {
        console.error(chalk.red('Error: specify at least --model or --peer.'))
        process.exit(1)
      }

      if (options.model !== undefined) {
        const model = String(options.model).trim()
        if (model.length === 0) {
          console.error(chalk.red('Error: --model must not be empty.'))
          process.exit(1)
        }
        state.pinnedModel = model
        console.log(chalk.green(`Pinned model set to: ${model}`))
      }

      if (options.peer !== undefined) {
        const peer = String(options.peer).trim()
        if (!/^[0-9a-f]{64}$/i.test(peer)) {
          console.error(chalk.red('Error: --peer must be a 64-character hex peer ID.'))
          process.exit(1)
        }
        state.pinnedPeerId = peer.toLowerCase()
        console.log(chalk.green(`Pinned peer set to: ${state.pinnedPeerId}`))
      }

      await writeStateFile(state)
    })

  connection
    .command('clear')
    .description('Clear session overrides (defaults to clearing both model and peer)')
    .option('--model', 'clear only the model override')
    .option('--peer', 'clear only the peer pin')
    .action(async (options) => {
      const state = await requireRunningBuyer()

      const clearAll = !options.model && !options.peer
      const clearModel = clearAll || Boolean(options.model)
      const clearPeer = clearAll || Boolean(options.peer)

      if (clearModel) state.pinnedModel = null
      if (clearPeer) state.pinnedPeerId = null

      await writeStateFile(state)

      if (clearModel && clearPeer) {
        console.log(chalk.green('All session overrides cleared.'))
      } else if (clearModel) {
        console.log(chalk.green('Model override cleared.'))
      } else {
        console.log(chalk.green('Peer pin cleared.'))
      }
    })
}
