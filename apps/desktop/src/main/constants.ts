import { homedir } from 'node:os';
import path from 'node:path';

export const DEFAULT_CONFIG_PATH = path.join(homedir(), '.antseed', 'config.json');
export const DEFAULT_BUYER_STATE_PATH = path.join(homedir(), '.antseed', 'buyer.state.json');
export const DEFAULT_DASHBOARD_PORT = 3117;