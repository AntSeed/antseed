/**
 * compositionalProbeSource — a large, rotatable ProbeSource built by crossing
 * every entity of every {@link COMPOSITIONAL_SCHEMAS} attribute schema.
 *
 * `consensus` is an advisory placeholder (the schema range midpoint): cohort
 * consensus supplies the real answer, so these probes MUST be scored in cohort
 * mode only, never against a reference self-test (`consensusCertified` false).
 */

import type { KbfProbe } from '../types.js';
import { deterministicSample, type ProbeGenerateParams, type ProbeSource } from '../probe-source.js';
import { COMPOSITIONAL_SCHEMAS, type AttributeSchema } from './dataset.js';

export const COMPOSITIONAL_SOURCE_ID = 'compositional/v1';

/** `Mount Everest` → `mount-everest`; drops articles so ids stay tidy. */
function slug(entity: string): string {
  return entity
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function schemaProbes(schema: AttributeSchema): KbfProbe[] {
  const midpoint = (schema.range[0] + schema.range[1]) / 2;
  const seen = new Set<string>();
  const probes: KbfProbe[] = [];
  for (const entity of schema.entities) {
    const id = `comp:${schema.domain}:${slug(entity)}`;
    if (seen.has(id)) continue; // defend against a repeated entity in a table
    seen.add(id);
    probes.push({
      id,
      name: entity,
      domain: schema.domain,
      template: schema.template.split('{name}').join(entity),
      consensus: midpoint,
      range: schema.range,
      tolerance: schema.tolerance,
      // Advisory: the range midpoint is a placeholder, not a fact. Cohort
      // consensus is the reference; reference self-tests must skip these.
      advisoryConsensus: true,
    });
  }
  return probes;
}

/**
 * Build the compositional probe source. The full pool is materialized once
 * (cheap — hundreds of small objects) and every `generate()` deterministically
 * samples it, honoring the rotation `exclude` set.
 */
export function compositionalProbeSource(
  schemas: readonly AttributeSchema[] = COMPOSITIONAL_SCHEMAS,
): ProbeSource {
  const pool: KbfProbe[] = [];
  const seen = new Set<string>();
  for (const schema of schemas) {
    for (const probe of schemaProbes(schema)) {
      if (seen.has(probe.id)) continue;
      seen.add(probe.id);
      pool.push(probe);
    }
  }
  return {
    id: COMPOSITIONAL_SOURCE_ID,
    size: pool.length,
    consensusCertified: false,
    generate: (params: ProbeGenerateParams) => deterministicSample(pool, params),
  };
}
