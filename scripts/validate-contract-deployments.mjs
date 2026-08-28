import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  generatedChainConfigFile,
  renderContractChainConfig,
} from './generate-contract-chain-config.mjs';
import { buildReleaseOwners } from './deployments/index.mjs';

const { Ajv2020 } = createRequire(import.meta.url)('ajv/dist/2020');

const deploymentsRoot = process.env.CONTRACT_DEPLOYMENTS_ROOT
  ? path.resolve(process.env.CONTRACT_DEPLOYMENTS_ROOT)
  : path.resolve('packages/contracts/deployments');

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateSchema = ajv.compile(await readJson(path.join(deploymentsRoot, 'schema.json')));

/**
 * Each migration may declare a `recordSchema` describing invariants that apply
 * only to the releases it owns. Compile them once, keyed by release.
 */
const releaseValidators = new Map();
for (const [release, migration] of buildReleaseOwners()) {
  if (migration.recordSchema) releaseValidators.set(release, ajv.compile(migration.recordSchema));
}

function formatSchemaErrors(errors) {
  return errors.map((error) => `${error.instancePath || '/'} ${error.message}`);
}

/**
 * Validates one record: the shared schema first, then whatever extra
 * invariants the migration that owns this release declares.
 */
function validateRecord(record, file) {
  const errors = [];
  if (JSON.stringify(record).includes('REPLACE_ME')) errors.push('contains an unresolved template placeholder');
  if (!validateSchema(record)) errors.push(...formatSchemaErrors(validateSchema.errors));

  const validateRelease = releaseValidators.get(record.release);
  if (validateRelease && !validateRelease(record)) errors.push(...formatSchemaErrors(validateRelease.errors));

  if (errors.length) throw new Error(`${file}:\n- ${errors.join('\n- ')}`);
}

async function validateNetwork(network) {
  const directory = path.join(deploymentsRoot, network);
  const currentFile = path.join(directory, 'current.json');
  const current = await readJson(currentFile);
  validateRecord(current, currentFile);
  if (current.network !== network) throw new Error(`${currentFile}: network does not match directory`);
  for (const pointer of ['emissions', 'staking']) {
    if (
      current.registryAfter?.[pointer]
      && current.registryAfter[pointer].toLowerCase() !== current.contracts?.[pointer]?.address?.toLowerCase()
    ) {
      throw new Error(`${currentFile}: contracts.${pointer} must match registryAfter.${pointer}`);
    }
  }

  const historyDirectory = path.join(directory, 'history');
  const historyFiles = (await readdir(historyDirectory)).filter((file) => file.endsWith('.json')).sort();
  const releases = new Set();
  for (const historyFile of historyFiles) {
    const file = path.join(historyDirectory, historyFile);
    const record = await readJson(file);
    validateRecord(record, file);
    if (record.network !== network || record.chainId !== current.chainId) {
      throw new Error(`${file}: network identity mismatch`);
    }
    if (`${record.release}.json` !== historyFile) throw new Error(`${file}: filename must match release ${record.release}`);
    if (releases.has(record.release)) throw new Error(`${file}: duplicate release ${record.release}`);
    releases.add(record.release);
  }
  if (!releases.has(current.release)) throw new Error(`${currentFile}: current release is missing from history`);
}

const networks = (await readdir(deploymentsRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
  .map((entry) => entry.name)
  .sort();

for (const network of networks) await validateNetwork(network);

if (!process.env.CONTRACT_DEPLOYMENTS_ROOT) {
  const generated = await readFile(generatedChainConfigFile, 'utf8');
  if (generated !== await renderContractChainConfig()) {
    throw new Error(`${generatedChainConfigFile} is stale; run node scripts/generate-contract-chain-config.mjs`);
  }
}

console.log(`Validated contract deployment records for ${networks.join(', ')}`);
