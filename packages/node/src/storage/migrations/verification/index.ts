import type { Migration } from '../../migrate.js';
import { migration as m001 } from './001_create_tables.js';
import { migration as m002 } from './002_create_request_costs.js';
import { migration as m009 } from './009_create_request_costs_compat.js';

export const verificationMigrations: Migration[] = [m001, m002, m009];
