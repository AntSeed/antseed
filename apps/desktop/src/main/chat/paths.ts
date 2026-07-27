import { homedir } from 'node:os';
import path from 'node:path';

export const ANTSEED_HOME_DIR = path.join(homedir(), '.antseed');
export const CHAT_DATA_DIR = path.join(ANTSEED_HOME_DIR, 'chat');
export const CHAT_WORKSPACE_DIR = path.join(ANTSEED_HOME_DIR, 'projects');
