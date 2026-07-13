import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Command } from 'commander'
import { join } from 'node:path'
import { registerDelegateCommands } from './index.js'
import { defaultVouchersPath } from './vouchers.js'

test('registers the delegate command group with vouchers and claim subcommands', () => {
  const program = new Command()
  registerDelegateCommands(program)

  const delegateCmd = program.commands.find((c) => c.name() === 'delegate')
  assert.ok(delegateCmd, 'delegate command must be registered')
  assert.match(delegateCmd.description(), /DelegateVoucher/)

  const subcommands = delegateCmd.commands.map((c) => c.name()).sort()
  assert.deepEqual(subcommands, ['claim', 'vouchers'])

  // Both surfaces the operator needs: listing and claiming.
  const vouchers = delegateCmd.commands.find((c) => c.name() === 'vouchers')!
  assert.match(vouchers.description(), /claim status/i)
  const claim = delegateCmd.commands.find((c) => c.name() === 'claim')!
  assert.match(claim.description(), /operator/i)
  const claimOptions = claim.options.map((o) => o.long)
  assert.ok(claimOptions.includes('--rpc-url'))
  assert.ok(claimOptions.includes('--file'))
  assert.ok(claimOptions.includes('--credits-only'))
})

test('default vouchers path matches where the delegate worker persists them', () => {
  // buyer start wires VoucherStore at <dataDir>/delegate/vouchers.jsonl —
  // the claim tooling must read the same file.
  assert.equal(defaultVouchersPath('/data'), join('/data', 'delegate', 'vouchers.jsonl'))
})
