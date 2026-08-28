import { loadDotEnv } from './env.mjs';
import { acquireMigrationLock } from './lock.mjs';
import { assertCheckpointSourceCommit, loadContext, validateArtifacts } from './ledger.mjs';
import { assertCleanForBroadcast, confirmBroadcast } from './preflight.mjs';
import { buildPlan, clearPlan, writePlan } from './plan.mjs';

/**
 * Generic driver shared by every migration.
 *
 * A migration declares WHAT it is (baseline, expected state, phases, how to
 * classify live state) and the runner owns HOW a rollout executes: dotenv
 * loading, locking, observation, guard evaluation, confirmation, clean-tree
 * enforcement, phase dispatch, record writing, and artifact validation.
 */
export async function runMigration(migration, options, overrides = {}) {
  if (options.mode === 'fork-test') return migration.forkTest(options, { runMigration });
  await loadDotEnv();
  const context = await loadContext(migration, options.network, overrides);
  const release = options.mode === 'broadcast' ? await acquireMigrationLock(context, migration.id) : async () => {};
  try {
    return await executePhases(migration, options, overrides, context);
  } finally {
    await release();
  }
}

export async function executePhases(migration, options, overrides, context) {
  let observation = await migration.observe(context);

  if (migration.recover && observation.state === 'invalid') {
    if (await migration.recover(context, observation)) observation = await migration.observe(context);
  }

  migration.printStatus(observation);

  if (observation.state === 'invalid') {
    throw new Error(`${migration.id} live state does not match a safe known state`);
  }

  const phase = selectPhase(migration, observation, options.mode);

  if (!phase) {
    if (migration.finalize) {
      const finalized = await migration.finalize(context, observation, options.mode);
      if (finalized) validateArtifacts(context);
    }
    console.log(migration.idleMessage(observation, options.mode));
    return observation;
  }

  const announcement = phase.announce?.(observation, options.mode);
  if (announcement) console.log(announcement);

  await phase.preflight?.(context, observation);

  const environment = migration.environment(context, observation, overrides.environment);
  migration.verifyRoleKeys(context, observation, environment);

  if (options.mode === 'broadcast') {
    assertCleanForBroadcast(context, migration.allowedDirtyReleases(observation));
    if (observation.deployment) assertCheckpointSourceCommit(context, observation.deployment.checkpoint);
    if (!context.forkTest) await confirmBroadcast(migration.id, options.network);
  }

  const runResult = await phase.run(context, options.mode, environment, observation);
  const planDescriptor = phase.plan
    ? await phase.plan(context, observation, runResult)
    : null;

  if (options.mode === 'dry-run' && planDescriptor) {
    const plan = await buildPlan({ context, observation, ...planDescriptor });
    const written = await writePlan(plan, context, planDescriptor.release);
    console.log(`Wrote deployment plan: ${written.plan}`);
    console.log(`Wrote review document: ${written.validation}`);
  }

  if (options.mode === 'broadcast') {
    if (planDescriptor) await clearPlan(context, planDescriptor.release);
    validateArtifacts(context);
  }

  return migration.observe(context);
}

/** Picks the first phase whose guard accepts the observed state, if any. */
function selectPhase(migration, observation, mode) {
  return migration.phases.find((phase) => phase.guard(observation, mode)) ?? null;
}
