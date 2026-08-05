import assert from 'node:assert/strict'
import test from 'node:test'
import type { ReadinessCheck } from '@antseed/node/payments'
import { failedBuyerReadinessChecks } from './runtime.js'

const failedGas: ReadinessCheck = {
  name: 'Gas balance',
  passed: false,
  message: 'No ETH for gas',
}

const failedDeposit: ReadinessCheck = {
  name: 'Deposit balance',
  passed: false,
  message: 'No USDC deposited',
}

test('evidence-only readiness ignores gas but still requires a buyer deposit', () => {
  assert.deepEqual(
    failedBuyerReadinessChecks([failedGas, failedDeposit], false),
    [failedDeposit],
  )
})

test('attestation readiness still requires gas and a buyer deposit', () => {
  assert.deepEqual(
    failedBuyerReadinessChecks([failedGas, failedDeposit], true),
    [failedGas, failedDeposit],
  )
})
