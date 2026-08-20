import type { Migration } from '../../migrate.js';
import { migration as m001 } from './001_create_video_job_tables.js';
import { migration as m002 } from './002_add_payment_channel.js';

export const videoMigrations: Migration[] = [m001, m002];
