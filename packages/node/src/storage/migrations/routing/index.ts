import type { Migration } from '../../migrate.js';
import { migration as m001 } from './001_create_tables.js';
import { migration as m002 } from './002_optional_router_telemetry.js';

export const routingMigrations: Migration[] = [m001, m002];
