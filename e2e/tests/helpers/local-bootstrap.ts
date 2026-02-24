import { DHTNode, type DHTNodeConfig } from '@antseed/node/discovery';
import { toPeerId } from '@antseed/node';

/**
 * Creates a local DHT bootstrap node for isolated testing.
 * Uses port 0 (OS-assigned) and an empty bootstrap list so the node
 * forms its own isolated DHT network.
 */
export async function createLocalBootstrap(): Promise<{
  dht: DHTNode;
  bootstrapConfig: Array<{ host: string; port: number }>;
  stop: () => Promise<void>;
}> {
  // We need a peerId for the DHTNodeConfig. Generate a dummy 64-char hex peerId.
  const peerId = toPeerId('0'.repeat(64));

  const config: DHTNodeConfig = {
    peerId,
    port: 0,                    // OS-assigned ephemeral port
    bootstrapNodes: [],         // Empty — this IS the bootstrap node
    reannounceIntervalMs: 60_000,
    operationTimeoutMs: 5_000,
  };

  const dht = new DHTNode(config);
  await dht.start();

  const port = dht.getPort();

  return {
    dht,
    bootstrapConfig: [{ host: '127.0.0.1', port }],
    stop: async () => {
      await dht.stop();
    },
  };
}
