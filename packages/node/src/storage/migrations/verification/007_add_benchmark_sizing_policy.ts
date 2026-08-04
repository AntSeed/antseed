import type { Migration } from '../../migrate.js';

export const migration: Migration = {
  version: 7,
  name: 'add_benchmark_sizing_policy',
  up: (db) => {
    const columns = new Set(
      (db.pragma('table_info(benchmark_runs)') as Array<{ name: string }>).map((column) => column.name),
    );
    const additions = [
      ['probe_sizing_mode', "TEXT NOT NULL DEFAULT 'fixed' CHECK (probe_sizing_mode IN ('fixed', 'auto'))"],
      ['minimum_probe_count', 'INTEGER'],
      ['maximum_probe_count', 'INTEGER'],
      ['probe_step', 'INTEGER'],
      ['family_wide_alpha', 'REAL'],
      ['per_peer_alpha', 'REAL'],
      ['minimum_mismatch_delta', 'REAL'],
      ['reference_confidence', 'REAL'],
      ['minimum_statistical_power', 'REAL'],
      ['achieved_statistical_power', 'REAL'],
      ['reference_error_upper_bound', 'REAL'],
      ['critical_mismatch_count', 'INTEGER'],
      ['minimum_target_coverage', 'REAL'],
    ] as const;
    for (const [name, declaration] of additions) {
      if (!columns.has(name)) db.exec(`ALTER TABLE benchmark_runs ADD COLUMN ${name} ${declaration}`);
    }
  },
};
