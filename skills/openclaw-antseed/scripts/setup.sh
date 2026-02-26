#!/usr/bin/env bash
set -euo pipefail

# Setup AntSeed buyer proxy for OpenClaw
#
# Usage:
#   ./setup.sh --model moonshotai/kimi-k2.5 [--port 5005] [--bootstrap HOST:PORT] [--service]
#
# Examples:
#   ./setup.sh --model moonshotai/kimi-k2.5
#   ./setup.sh --model moonshotai/kimi-k2.5 --port 5005 --bootstrap 108.128.178.49:6882 --service

PORT=5005
MODEL=""
MODEL_NAME=""
BOOTSTRAP=""
INSTALL_SERVICE=false
CONTEXT_WINDOW=131072
MAX_TOKENS=8192

usage() {
  cat <<EOF
Usage: $0 --model <model-id> [options]

Required:
  --model <id>              Model ID available on the network (e.g., moonshotai/kimi-k2.5)

Options:
  --model-name <name>       Display name for the model (default: derived from model ID)
  --port <n>                Buyer proxy port (default: 5005)
  --bootstrap <host:port>   Bootstrap node address (e.g., 108.128.178.49:6882)
  --context-window <n>      Model context window size (default: 131072)
  --max-tokens <n>          Model max output tokens (default: 8192)
  --service                 Install as systemd service
  -h, --help                Show this help
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --model) MODEL="$2"; shift 2 ;;
    --model-name) MODEL_NAME="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --bootstrap) BOOTSTRAP="$2"; shift 2 ;;
    --context-window) CONTEXT_WINDOW="$2"; shift 2 ;;
    --max-tokens) MAX_TOKENS="$2"; shift 2 ;;
    --service) INSTALL_SERVICE=true; shift ;;
    --help|-h) usage ;;
    *) echo "Unknown option: $1"; usage ;;
  esac
done

if [ -z "$MODEL" ]; then
  echo "Error: --model is required"
  usage
fi

if [ -z "$MODEL_NAME" ]; then
  MODEL_NAME="$MODEL via AntSeed"
fi

echo "==> Installing AntSeed CLI..."
if ! command -v antseed &>/dev/null; then
  npm install -g @antseed/cli
fi
echo "  CLI version: $(antseed --version)"

echo "==> Installing buyer proxy plugin..."
antseed plugin add @antseed/router-local-proxy </dev/null 2>&1 | tail -3 || true

# Add bootstrap node if specified
if [ -n "$BOOTSTRAP" ]; then
  BOOTSTRAP_HOST="${BOOTSTRAP%%:*}"
  BOOTSTRAP_PORT="${BOOTSTRAP##*:}"
  echo "==> Adding bootstrap node ${BOOTSTRAP_HOST}:${BOOTSTRAP_PORT}..."
  if [ -f ~/.antseed/config.json ]; then
    python3 -c "
import json, sys
cfg = json.load(open('$HOME/.antseed/config.json'))
nodes = cfg.setdefault('bootstrapNodes', [])
entry = {'host': '${BOOTSTRAP_HOST}', 'port': int('${BOOTSTRAP_PORT}')}
if entry not in nodes:
    nodes.append(entry)
json.dump(cfg, open('$HOME/.antseed/config.json', 'w'), indent=2)
print('  Added to ~/.antseed/config.json')
"
  else
    echo "  Warning: ~/.antseed/config.json not found. Run 'antseed init' first."
  fi
fi

echo "==> Configuring OpenClaw model provider..."
if ! command -v openclaw &>/dev/null; then
  echo "Error: openclaw not found. Install it first: npm install -g openclaw"
  exit 1
fi

OPENCLAW_CONFIG="${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}"
if [ ! -f "$OPENCLAW_CONFIG" ]; then
  echo "Error: OpenClaw config not found at $OPENCLAW_CONFIG"
  exit 1
fi

python3 -c "
import json, sys

cfg = json.load(open('${OPENCLAW_CONFIG}'))

# Set up model provider
providers = cfg.setdefault('models', {}).setdefault('providers', {})
providers['antseed'] = {
    'baseUrl': 'http://127.0.0.1:${PORT}',
    'apiKey': 'antseed-p2p',
    'api': 'anthropic-messages',
    'models': [{
        'id': '${MODEL}',
        'name': '${MODEL_NAME}',
        'reasoning': False,
        'input': ['text'],
        'contextWindow': ${CONTEXT_WINDOW},
        'maxTokens': ${MAX_TOKENS}
    }]
}

# Set as default model
cfg.setdefault('agents', {}).setdefault('defaults', {}).setdefault('model', {})['primary'] = 'antseed/${MODEL}'

json.dump(cfg, open('${OPENCLAW_CONFIG}', 'w'), indent=2)
print('  Provider configured: antseed/${MODEL}')
print('  Default model set: antseed/${MODEL}')
"

if [ "$INSTALL_SERVICE" = true ]; then
  echo "==> Installing systemd service..."
  ANTSEED_BIN=$(command -v antseed)
  sudo tee /etc/systemd/system/antseed-buyer.service > /dev/null <<SERVICE
[Unit]
Description=AntSeed Buyer Proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$(whoami)
ExecStart=${ANTSEED_BIN} connect --router local-proxy --port ${PORT}
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=antseed-buyer

[Install]
WantedBy=multi-user.target
SERVICE
  sudo systemctl daemon-reload
  sudo systemctl enable --now antseed-buyer
  echo "  Service installed and started"
else
  echo ""
  echo "==> To start the buyer proxy:"
  echo "  antseed connect --router local-proxy --port ${PORT}"
  echo ""
  echo "  Or install as a service with: $0 --model ${MODEL} --service"
fi

echo ""
echo "==> Restart the OpenClaw gateway to apply changes."
echo "==> Done"
