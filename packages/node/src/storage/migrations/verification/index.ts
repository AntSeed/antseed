import type { Migration } from '../../migrate.js';
import { migration as m001 } from './001_create_tables.js';
import { migration as m002 } from './002_create_audit_relay_tables.js';
import { migration as m003 } from './003_create_reference_rotation_tables.js';
import { migration as m004 } from './004_create_dynamic_reference_catalog.js';

export const verificationMigrations: Migration[] = [m001, m002, m003, m004];
