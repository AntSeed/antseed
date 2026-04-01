import type { Migration } from '../../migrate.js';
import { migration as m001 } from './001_create_tables.js';

export const meteringMigrations: Migration[] = [m001];
