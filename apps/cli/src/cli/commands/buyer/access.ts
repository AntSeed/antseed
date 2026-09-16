import type { Command } from 'commander'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getGlobalOptions } from '../types.js'

export function registerBuyerAccessCommand(buyerCmd: Command): void {
  buyerCmd.command('access <action> <sellerPeerId> <serviceId>')
    .description('Inspect, activate, or pause purchase-on-use access (action: status, activate, pause)')
    .option('--amount-micro-usdc <amount>', 'Exact accepted pass price in micro-USDC')
    .option('--duration-seconds <seconds>', 'Exact accepted pass duration')
    .action(async (action: string, sellerPeerId: string, serviceId: string, options: { amountMicroUsdc?: string; durationSeconds?: string }) => {
      if (!['status', 'activate', 'pause'].includes(action)) throw new Error('Expected status, activate, or pause')
      if (action === 'activate' && (!options.amountMicroUsdc || !options.durationSeconds)) {
        throw new Error('Inspect status first, then supply --amount-micro-usdc and --duration-seconds explicitly')
      }
      const global = getGlobalOptions(buyerCmd)
      const state = JSON.parse(await readFile(join(global.dataDir, 'buyer.state.json'), 'utf8')) as { port?: number; state?: string }
      if (state.state !== 'connected' || !Number.isInteger(state.port) || state.port! < 1 || state.port! > 65535) throw new Error('Start the buyer proxy first')
      const url = new URL(`http://127.0.0.1:${state.port}/_antseed/access-billing`)
      url.search = new URLSearchParams({ sellerPeerId, serviceId }).toString()
      const response = await fetch(url, action === 'status' ? { signal: AbortSignal.timeout(10_000) } : {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ action, sellerPeerId, serviceId, amountMicroUsdc: options.amountMicroUsdc, durationSeconds: Number(options.durationSeconds) }),
      })
      const result = await response.json() as { ok?: boolean; error?: string }
      if (!response.ok || !result.ok) throw new Error(result.error ?? 'Access billing request failed')
      console.log(JSON.stringify(result, null, 2))
    })
}
