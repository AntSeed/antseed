import type { Migration } from '../../migrate.js';
import { migration as m001 } from './001_create_tables.js';
import { migration as m002 } from './002_create_audit_relay_tables.js';
import { migration as m003 } from './003_create_reference_rotation_tables.js';
import { migration as m004 } from './004_create_dynamic_reference_catalog.js';
import { migration as m005 } from './005_replace_audit_relay_tables_with_direct_audits.js';
import { migration as m006 } from './006_create_benchmark_runs.js';
import { migration as m007 } from './007_add_benchmark_sizing_policy.js';
import { migration as m008 } from './008_create_traffic_share_snapshots.js';

export const verificationMigrations: Migration[] = [m001, m002, m003, m004, m005, m006, m007, m008];
