# Phala (dstack TDX CVM)

Run the seller inside the Phala CVM. Mount `/var/run/dstack.sock` into the container.

```bash
export ANTSEED_TEE_PEER_ID=<peer id, no 0x>
export ANTSEED_VERIFIER_SIGNING_KEY=<hex key; address == peer id>
export ANTSEED_VERIFIER_NODE_TEE=dstack
# export ANTSEED_VERIFIER_DSTACK_SOCKET=/custom/path.sock   # if not /var/run/dstack.sock
```

Start the seller with `--verifiers antseed-verifier`. Buyers attest with `--require-verifier`.

Ports: public host ports must equal container ports, for signaling (TCP) and DHT (UDP).
