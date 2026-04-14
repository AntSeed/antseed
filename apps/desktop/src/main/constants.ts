import { homedir } from 'node:os';
import path from 'node:path';

export const DEFAULT_CONFIG_PATH = path.join(homedir(), '.antseed', 'config.json');
export const DEFAULT_BUYER_STATE_PATH = path.join(homedir(), '.antseed', 'buyer.state.json');
export const DEFAULT_DASHBOARD_PORT = 3117;

// mainnet.base.org rate-limits concurrent eth_call reads and intermittently
// returns CALL_EXCEPTION / "missing revert data", which wedges the credits
// pill at $0.00 on desktop. base-rpc.publicnode.com handles the concurrent
// read pattern cleanly. Users can still override via payments.crypto.rpcUrl.
export const DESKTOP_DEFAULT_BASE_MAINNET_RPC_URL = 'https://base-rpc.publicnode.com';
