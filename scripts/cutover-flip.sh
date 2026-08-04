#!/usr/bin/env bash
set -euo pipefail

# Long-running runner for broadcast #2 of the recognized-usage cutover.
#
# Timeline it drives (epoch N = the epoch DeployRecognizedUsage ran in):
#   T-60s   pause AntseedChannels — no settlements anywhere on the network can
#           land on the legacy ledger for epoch N+1, so the dual-ledger sliver
#           between the boundary and the flip cannot exist
#   T       epoch N finalizes (gate's effective epoch starts)
#   T+      run CutoverFlip.s.sol: claim the DiemStakingProxy's pre-effective
#           reward epochs from legacy V2 (paid by the escrow), pin the seller
#           rewards pool registry facade, flip registry emissions/staking
#   always  unpause AntseedChannels (trap — runs even if the flip fails, so a
#           failed run never leaves network payments stuck)
#
# Env (read from packages/contracts/.env plus the environment):
#   BASE_MAINNET_RPC_URL         RPC endpoint
#   ANTSEED_REGISTRY             legacy AntseedRegistry
#   USAGE_ACCOUNTING             printed by DeployRecognizedUsage
#   SELLER_REGISTRY              printed by DeployRecognizedUsage
#   REGISTRY_OWNER_PRIVATE_KEY   AntseedRegistry owner key (signs the flips)
#   DIEM_STAKING_PROXY           deployed DiemStakingProxy (claim phase)
#   DIEM_STAKER_PRIVATE_KEY      key with DIEM staked on the proxy (signs claims)
# Optional:
#   CHANNELS_OWNER_PRIVATE_KEY   AntseedChannels owner key for pause/unpause
#                                (falls back to DIEM_STAKER_PRIVATE_KEY)
#   DRY_RUN=1                    simulate only: no pause, no --broadcast
#   POLL_SECS=30                 on-chain poll interval near the boundary

cd "$(dirname "$0")/../packages/contracts"
if [[ -f .env ]]; then set -a; source .env; set +a; fi

RPC="${BASE_MAINNET_RPC_URL:?BASE_MAINNET_RPC_URL not set}"
: "${ANTSEED_REGISTRY:?ANTSEED_REGISTRY not set}"
: "${USAGE_ACCOUNTING:?USAGE_ACCOUNTING not set (printed by DeployRecognizedUsage)}"
: "${SELLER_REGISTRY:?SELLER_REGISTRY not set (printed by DeployRecognizedUsage)}"
: "${REGISTRY_OWNER_PRIVATE_KEY:?REGISTRY_OWNER_PRIVATE_KEY not set}"

DRY="${DRY_RUN:-0}"
PAUSE_KEY="${CHANNELS_OWNER_PRIVATE_KEY:-${DIEM_STAKER_PRIVATE_KEY:-}}"
[[ -n "$PAUSE_KEY" || "$DRY" == "1" ]] || {
  echo "CHANNELS_OWNER_PRIVATE_KEY or DIEM_STAKER_PRIVATE_KEY required to pause channels" >&2
  exit 1
}

num() { awk '{print $1}'; }

GATE=$(cast call "$USAGE_ACCOUNTING" 'emissionsGate()(address)' --rpc-url "$RPC")
GENESIS=$(cast call "$GATE" 'genesis()(uint256)' --rpc-url "$RPC" | num)
DURATION=$(cast call "$GATE" 'epochDuration()(uint256)' --rpc-url "$RPC" | num)
EFFECTIVE=$(cast call "$GATE" 'effectiveEpoch()(uint256)' --rpc-url "$RPC" | num)
CHANNELS=$(cast call "$ANTSEED_REGISTRY" 'channels()(address)' --rpc-url "$RPC")
TARGET=$((GENESIS + EFFECTIVE * DURATION))

echo "gate:            $GATE"
echo "channels:        $CHANNELS"
echo "effective epoch: $EFFECTIVE (starts at unix $TARGET)"

PAUSED_BY_US=0
unpause_channels() {
  if (( PAUSED_BY_US )); then
    echo "unpausing channels..."
    cast send "$CHANNELS" 'unpause()' --private-key "$PAUSE_KEY" --rpc-url "$RPC" >/dev/null
    PAUSED_BY_US=0
    echo "channels unpaused"
  fi
}
trap unpause_channels EXIT

pause_channels() {
  [[ "$DRY" == "1" ]] && { echo "DRY_RUN: skipping channels pause"; return; }
  if [[ "$(cast call "$CHANNELS" 'paused()(bool)' --rpc-url "$RPC")" == "false" ]]; then
    echo "pausing channels..."
    cast send "$CHANNELS" 'pause()' --private-key "$PAUSE_KEY" --rpc-url "$RPC" >/dev/null
    PAUSED_BY_US=1
    echo "channels paused"
  else
    echo "channels already paused (not by us - will not unpause)"
  fi
}

wait_until() {
  local until_ts=$1
  while (( $(date +%s) < until_ts )); do
    local left=$(( until_ts - $(date +%s) ))
    local nap=$(( left > 300 ? 300 : left + 1 ))
    sleep "$nap"
  done
}

PAUSE_AT=$((TARGET - 60))
NOW=$(date +%s)
if (( NOW < PAUSE_AT )); then
  echo "waiting $((PAUSE_AT - NOW))s until channels pause (boundary - 60s)..."
  wait_until "$PAUSE_AT"
fi

pause_channels

if (( $(date +%s) < TARGET )); then
  echo "waiting for the epoch boundary..."
  wait_until "$TARGET"
fi

# Confirm on-chain: wall clock can drift from block timestamps.
POLL="${POLL_SECS:-30}"
while :; do
  CURRENT=$(cast call "$GATE" 'currentEpoch()(uint256)' --rpc-url "$RPC" | num)
  (( CURRENT >= EFFECTIVE )) && break
  echo "current epoch $CURRENT < $EFFECTIVE, polling again in ${POLL}s..."
  sleep "$POLL"
done

echo "epoch $EFFECTIVE started — running CutoverFlip"
ARGS=(--rpc-url "$RPC" --via-ir)
[[ "$DRY" == "1" ]] || ARGS+=(--broadcast)
forge script script/CutoverFlip.s.sol "${ARGS[@]}"

echo "flip complete"
