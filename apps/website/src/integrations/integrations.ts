/**
 * Single source of truth for AntSeed integration entries.
 *
 * Both `/integrations` (the public hub) and `/skill.md` (the agent-readable
 * guide) are generated from this file. The desktop app's "External clients"
 * view should also migrate to this list — see TODO in
 * apps/desktop/src/renderer/ui/components/views/ExternalClientsView.tsx.
 *
 * When adding a new tool / SDK / partner, add an entry below and the page
 * appears at /integrations/<slug> automatically (the route is registered by
 * apps/website/plugins/integrations-pages.ts).
 */

/**
 * Wire format the tool sends to the buyer proxy. AntSeed's @antseed/api-adapter
 * transparently translates between any pair of these, so a tool that speaks
 * `anthropic-messages` can still talk to a peer whose service is natively
 * `openai-chat-completions` (and vice versa).
 *
 * Translation is lossless for the common case but adds a small overhead and
 * has a few edge cases (notably: `openai-responses` services REQUIRE streaming,
 * so non-streaming requests against them fail). For best-fit, prefer services
 * whose advertised `protocols` array (in `providerServiceApiProtocols` /
 * `matchingServices[].protocols` on a peer) contains the tool's wire format.
 *
 * NOTE: a peer's `provider` field is a seller-plugin label (`anthropic`,
 * `openai`, `local-llm`, ...) and is NOT the wire format. Always look at the
 * service-level `protocols` array.
 */
export type IntegrationFormat =
  | 'anthropic-messages'
  | 'openai-chat'
  | 'openai-responses'
  | 'multi';

/** Buyer-proxy endpoint each wire format hits. */
export const FORMAT_ENDPOINT: Record<IntegrationFormat, string> = {
  'anthropic-messages': '/v1/messages',
  'openai-chat': '/v1/chat/completions',
  'openai-responses': '/v1/responses',
  multi: '(varies)',
};

/**
 * The canonical protocol identifier that AntSeed peers advertise per service
 * (in `providerServiceApiProtocols` / `matchingServices[].protocols`) and that
 * @antseed/api-adapter uses internally as `ServiceApiProtocol`. This is the
 * value to look for when judging whether a peer is a *native* fit for a tool.
 *
 * The `provider` field on a peer is just a seller-side plugin name (e.g.
 * `anthropic`, `openai`, `local-llm`) — a label, NOT the wire format. The wire
 * format lives in `protocols`.
 */
export const FORMAT_TO_PROTOCOL: Record<
  Exclude<IntegrationFormat, 'multi'>,
  string
> = {
  'anthropic-messages': 'anthropic-messages',
  'openai-chat': 'openai-chat-completions',
  'openai-responses': 'openai-responses',
};

export type IntegrationCategory =
  | 'coding-agent'
  | 'framework'
  | 'agent-platform'
  | 'cli';

export type IntegrationStatus = 'verified' | 'community' | 'coming-soon';

export type ConfigBlock =
  | { kind: 'env'; vars: Record<string, string>; note?: string }
  | { kind: 'file'; path: string; language: string; snippet: string; note?: string }
  | { kind: 'code'; language: string; snippet: string; note?: string }
  | { kind: 'gui'; instructions: string; note?: string };

export type Step = {
  /** One short imperative line. */
  label: string;
  /** Optional shell command or code block. */
  command?: string;
  /** Language for syntax highlighting if `command` is present. Default: bash. */
  language?: string;
  /** Optional explanatory paragraph below the command. */
  note?: string;
  /** Optional example output — rendered as a muted code block under the command
   * so users know what to expect on success. */
  output?: string;
  /** Label for the output block. Default: 'Example output'. */
  outputLabel?: string;
};

export type Integration = {
  slug: string;
  name: string;
  /** Path under /logos/ — falls back to a text glyph if missing. */
  logo?: string;
  /** Short fallback shown when no logo exists yet. */
  glyph?: string;
  category: IntegrationCategory;
  format: IntegrationFormat;
  setupMinutes: number;
  status: IntegrationStatus;
  /** ≤ 90 chars. Shown on the hub card. */
  oneLiner: string;
  /** 1–3 short paragraphs. Shown at top of the integration page. */
  description: string[];
  /** Things the user needs before starting (besides AntSeed itself). */
  prereqs?: string[];
  /** "Install <tool>" — only this tool's install steps. AntSeed install is shared. */
  install: Step[];
  /** "Configure <tool>" — point it at the local AntSeed proxy. */
  configure: ConfigBlock[];
  /** "Pick a model" hints. */
  modelHints?: {
    /** Recommended service ids the user can try first. */
    suggested: string[];
    /** Free-form note about model selection in this tool. */
    note?: string;
  };
  /** "Test it" command(s). */
  test?: Step[];
  /** Known issues + fixes. */
  troubleshooting?: { problem: string; fix: string }[];
  /** Things that don't work / partially work / are coming. */
  caveats?: string[];
  /** External links: upstream docs, our skill, partner page. */
  links?: { label: string; href: string }[];
  /** Agent-friendly machine summary used by /skill.md. */
  agentSummary?: string;
};

const ANT_PORT = 8377;

/* ------------------------------------------------------------------ *
 * The list. Order here = order on the hub (within each category).
 * ------------------------------------------------------------------ */

export const integrations: Integration[] = [
  /* ---------------- Coding agents ---------------- */
  {
    slug: 'claude-code',
    name: 'Claude Code',
    logo: 'anthropic.png',
    category: 'coding-agent',
    format: 'anthropic-messages',
    setupMinutes: 2,
    status: 'verified',
    oneLiner: "Anthropic's official CLI agent — drop-in via ANTHROPIC_BASE_URL.",
    description: [
      'Claude Code is the official CLI coding agent from Anthropic. It speaks the Anthropic Messages API natively, so it slots into AntSeed by simply pointing `ANTHROPIC_BASE_URL` at your local proxy.',
      'No real Anthropic API key is needed — the AntSeed proxy authenticates each request with your local identity (`ANTSEED_IDENTITY_HEX`) and settles payments on-chain. The `ANTHROPIC_API_KEY` value is required by the Anthropic SDK only as a non-empty placeholder.',
      'When Claude Code calls the Messages API, the proxy forwards the request to the peer you pinned in step 3 of the setup above. Whichever <em>service ids</em> that peer advertises (visible in <code>antseed network peer &lt;peerId&gt;</code>) become the valid <code>--model</code> values.',
    ],
    install: [
      { label: 'Install Claude Code globally', command: 'npm install -g @anthropic-ai/claude-code' },
      {
        label: 'Verify it runs',
        command: 'claude --version',
        output: '1.4.2 (Claude Code)',
      },
    ],
    configure: [
      {
        kind: 'env',
        vars: {
          ANTHROPIC_BASE_URL: `http://localhost:${ANT_PORT}`,
          ANTHROPIC_API_KEY: 'antseed',
        },
      },
    ],
    modelHints: {
      suggested: ['claude-sonnet-4-6', 'claude-opus-4-7', 'deepseek-v4-flash'],
      note: "Claude Code's `--model` flag passes the value to the Messages API unchanged. The valid set is whatever your pinned peer advertises — see the discovery commands below.",
    },
    test: [
      {
        label: 'See which models your pinned peer offers',
        command: 'curl -s http://localhost:8377/v1/models | jq \'.data[].id\'',
        outputLabel: 'Example response',
        output: `"claude-opus-4-7"
"claude-sonnet-4-6"
"deepseek-v4-flash"
"gpt-oss-120b"`,
        note:
          'These are the only ids that work with `--model`. To switch peers, run `antseed network browse`, then `antseed buyer connection set --peer <peerId>` and re-check this list.',
      },
      {
        label: 'Start a Claude Code session against AntSeed',
        command: 'claude --model claude-sonnet-4-6',
      },
    ],
    troubleshooting: [
      {
        problem: '"invalid x-api-key" or 401 from Anthropic SDK',
        fix: 'The SDK requires *some* value for `ANTHROPIC_API_KEY`. Set it to any non-empty string (e.g. `antseed`). The proxy ignores the value.',
      },
      {
        problem: 'Hangs forever on first message',
        fix: 'No peer is pinned. Run `antseed network browse` to see peers, then `antseed buyer connection set --peer <peerId>`.',
      },
      {
        problem: '`model_not_found` for a model name you expected to work',
        fix: 'The pinned peer doesn\'t advertise that service id. Check what it does offer with `antseed network peer <peerId>` (or `curl http://localhost:8377/v1/models`). Pin a different peer if needed.',
      },
      {
        problem: 'Want to confirm a request actually went through AntSeed (not Anthropic direct)',
        fix: 'After the request completes, run `antseed buyer metering` — you\'ll see the channel for the peer Claude Code routed to, with token counts and the USDC settled. `antseed buyer status` shows the snapshot (pinned peer, active-channel count, deposits).',
      },
    ],
    links: [
      { label: 'Claude Code docs', href: 'https://docs.anthropic.com/en/docs/claude-code' },
      { label: 'AntSeed skill: join-buyer', href: 'https://github.com/AntSeed/antseed/tree/main/skills/join-buyer' },
    ],
    agentSummary:
      'Set ANTHROPIC_BASE_URL=http://localhost:8377 and ANTHROPIC_API_KEY=antseed, then `claude --model <service-id>`. The valid service ids are returned by `curl http://localhost:8377/v1/models` after pinning a peer.',
  },
  {
    slug: 'codex',
    name: 'OpenAI Codex CLI',
    logo: 'openai.png',
    category: 'coding-agent',
    format: 'openai-chat',
    setupMinutes: 3,
    status: 'verified',
    oneLiner: "OpenAI's official CLI coding agent — add an AntSeed profile to ~/.codex/config.toml.",
    description: [
      "Codex is OpenAI's terminal coding agent. Recent versions ignore `OPENAI_BASE_URL` and instead read `~/.codex/config.toml`, where you declare custom inference providers under `[model_providers]` and bundle them into named `[profiles]` you can select with `--profile`.",
      'AntSeed plugs in as a `model_provider` pointed at the local buyer proxy. Pair it with a profile and you can swap between OpenAI proper and AntSeed by changing one flag.',
    ],
    install: [
      { label: 'Install Codex globally', command: 'npm install -g @openai/codex' },
      { label: 'Verify it runs', command: 'codex --version' },
    ],
    configure: [
      {
        kind: 'file',
        path: '~/.codex/config.toml',
        language: 'toml',
        snippet: `# Register AntSeed as a custom model provider.
[model_providers.antseed]
name    = "AntSeed"
base_url = "http://localhost:${ANT_PORT}/v1"
wire_api = "chat"   # or "responses" — AntSeed supports both

# Bundle the provider + a default model into a profile.
[profiles.antseed]
model          = "claude-sonnet-4-6"
model_provider = "antseed"

# Optional: make AntSeed the default profile so you don't need --profile every time.
# profile = "antseed"`,
      },
      {
        kind: 'gui',
        instructions:
          'No API key is needed — the AntSeed proxy authenticates every request using your local identity, not an Authorization header. If Codex prompts for a key on first run, type any non-empty value and continue.',
      },
    ],
    modelHints: {
      suggested: ['claude-sonnet-4-6', 'deepseek-v3.1', 'kimi-k2.5', 'qwen-3-coder-480b'],
      note: 'Set `model = "<service-id>"` inside `[profiles.antseed]`, or override per-session with `codex --profile antseed --model <service-id>`. Anything your pinned peer advertises works.',
    },
    test: [
      {
        label: 'See which service ids your pinned peer exposes',
        command: 'curl -s http://localhost:8377/v1/models | jq \'.data[].id\'',
        outputLabel: 'Example response',
        output: `"claude-opus-4-7"
"claude-sonnet-4-6"
"deepseek-v4-flash"
"gpt-oss-120b"`,
        note:
          'Whatever appears here is a valid value for `model = ...` inside `[profiles.antseed]` (or for `codex --profile antseed --model <id>`).',
      },
      {
        label: 'Run Codex against AntSeed',
        command: 'codex --profile antseed',
        note: 'Or pin a model for one session: `codex --profile antseed --model deepseek-v4-flash`.',
      },
    ],
    troubleshooting: [
      {
        problem: '`OPENAI_BASE_URL` / `OPENAI_API_KEY` are being ignored',
        fix: 'Expected on Codex 0.40+ — it no longer reads OpenAI env vars and only loads providers from `~/.codex/config.toml`. Use the profile shown above and launch with `codex --profile antseed`.',
      },
      {
        problem: 'Streaming stops after the first chunk',
        fix: 'Switch `wire_api` between `"chat"` and `"responses"` in `[model_providers.antseed]`. AntSeed implements both; one may behave better with your Codex build.',
      },
      {
        problem: '`unknown profile: antseed`',
        fix: 'Codex caches the config on launch. Make sure you saved `~/.codex/config.toml`, then start a fresh `codex` session.',
      },
      {
        problem: 'Hangs forever on first message',
        fix: 'No peer is pinned. Run `antseed network browse`, then `antseed buyer connection set --peer <peerId>`.',
      },
    ],
    links: [
      { label: 'Codex repo', href: 'https://github.com/openai/codex' },
      { label: 'Codex sample config', href: 'https://developers.openai.com/codex/config-sample' },
    ],
    agentSummary:
      'Add [model_providers.antseed] (base_url=http://localhost:8377/v1, wire_api="chat") and [profiles.antseed] (model_provider="antseed", model="<service-id>") to ~/.codex/config.toml, then run `codex --profile antseed`.',
  },
  {
    slug: 'opencode',
    name: 'OpenCode',
    glyph: 'OC',
    category: 'coding-agent',
    format: 'openai-chat',
    setupMinutes: 3,
    status: 'verified',
    oneLiner: 'Open-source AI coding agent — add AntSeed as a custom OpenAI-compatible provider.',
    description: [
      'OpenCode is an MIT-licensed terminal coding agent built on the Vercel AI SDK. It supports 75+ providers out of the box and lets you register custom ones via <code>opencode.json</code>.',
      'AntSeed plugs in as a <strong>custom provider</strong> using the <code>@ai-sdk/openai-compatible</code> adapter — the same one OpenCode recommends for any OpenAI-compatible endpoint (LM Studio, llama.cpp, Atomic Chat, etc.). No environment variables, no <code>ANTHROPIC_BASE_URL</code>: the config lives in JSON.',
      'Each model you want to use must be listed under <code>models</code>. The id has to match what the buyer proxy returns from <code>GET /v1/models</code> — i.e. a service id advertised by your currently-pinned peer.',
    ],
    install: [
      { label: 'Install OpenCode', command: 'npm install -g opencode-ai' },
      {
        label: 'Verify it runs',
        command: 'opencode --version',
      },
    ],
    configure: [
      {
        kind: 'file',
        path: 'opencode.json  (project root, or ~/.config/opencode/opencode.json for global)',
        language: 'json',
        snippet: `{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "antseed": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "AntSeed (peer-to-peer)",
      "options": {
        "baseURL": "http://localhost:${ANT_PORT}/v1"
      },
      "models": {
        "claude-sonnet-4-6":  { "name": "Claude Sonnet 4.6 (via AntSeed)" },
        "deepseek-v4-flash":  { "name": "DeepSeek v4 Flash (via AntSeed)" },
        "gpt-oss-120b":       { "name": "gpt-oss 120B (via AntSeed)" }
      }
    }
  }
}`,
      },
    ],
    modelHints: {
      suggested: ['claude-sonnet-4-6', 'claude-opus-4-7', 'deepseek-v4-flash', 'gpt-oss-120b'],
      note:
        'The keys under `models` must exactly match service ids returned by `curl http://localhost:8377/v1/models`. If your pinned peer doesn\'t advertise an id, OpenCode will list it but every call to it returns `404 model_not_found`.',
    },
    test: [
      {
        label: 'Confirm the proxy lists the same ids your config references',
        command: 'curl -s http://localhost:8377/v1/models | jq \'.data[].id\'',
        outputLabel: 'Example response',
        output: `"claude-opus-4-7"
"claude-sonnet-4-6"
"deepseek-v4-flash"
"gpt-oss-120b"`,
        note: 'Add or remove entries under `models` in `opencode.json` so they match this list.',
      },
      {
        label: 'Launch OpenCode in your project',
        command: 'opencode',
        note:
          'Inside the TUI, run `/models` and pick one of the AntSeed entries. OpenCode remembers your last selection per project.',
      },
    ],
    troubleshooting: [
      {
        problem: 'AntSeed doesn\'t appear in `/connect` or `/models`',
        fix: 'OpenCode only loads providers declared in `opencode.json`. Make sure the file is in your project root (or `~/.config/opencode/opencode.json`) and that the JSON is valid — a stray comma silently disables the whole provider.',
      },
      {
        problem: 'Model is listed but every call returns `model_not_found`',
        fix: 'The pinned peer doesn\'t advertise that service id. Run `antseed network peer <peerId>` to see what it actually offers, or pin a different peer.',
      },
      {
        problem: 'OpenCode prompts for an API key',
        fix: 'The proxy ignores auth, but the AI SDK sometimes asks anyway. Either skip the prompt (press enter on empty input) or set `"apiKey": "antseed"` inside `options` in `opencode.json`.',
      },
    ],
    links: [
      { label: 'OpenCode docs → Custom provider', href: 'https://opencode.ai/docs/providers/#custom-provider' },
      { label: 'OpenCode repo', href: 'https://github.com/sst/opencode' },
    ],
    agentSummary:
      'In opencode.json, register a custom provider with npm="@ai-sdk/openai-compatible", baseURL="http://localhost:8377/v1", and a `models` map whose keys match service ids from GET /v1/models. Then run `opencode` and pick the model via /models.',
  },
  {
    slug: 'pi',
    name: 'Pi',
    glyph: 'π',
    category: 'coding-agent',
    format: 'openai-responses',
    setupMinutes: 3,
    status: 'verified',
    oneLiner: 'Open-source terminal coding agent with a first-class AntSeed extension.',
    description: [
      '<strong>What Pi is.</strong> Pi (<code>@mariozechner/pi-coding-agent</code>) is a minimal, hackable terminal coding agent by Mario Zechner — the same lineage as <a href="https://github.com/badlogic/pi-mono">pi-mono</a>. It ships with four default tools (<code>read</code>, <code>write</code>, <code>edit</code>, <code>bash</code>) and lets you extend everything else — commands, providers, themes, even the editor UI — through TypeScript <em>extensions</em>, <em>skills</em>, and <em>prompt templates</em>. No fork required.',
      '<strong>What the AntSeed extension does.</strong> <a href="https://github.com/AntSeed/pi-antseed"><code>pi-antseed</code></a> is a Pi extension that registers the local buyer proxy as a Pi provider named <code>antseed</code>. Once installed, every service your pinned peer advertises shows up under <code>antseed/&lt;id&gt;</code> in Pi\'s model picker (Ctrl+L or <code>/model</code>) — you switch with <code>/model antseed/minimax-m2.7</code> just like any built-in.',
      '<strong>Why an extension instead of env vars.</strong> Pi already speaks dozens of provider protocols natively. The extension calls <code>pi.registerProvider("antseed", { api: "openai-responses", authHeader: true, baseUrl: "http://localhost:8377/v1" })</code> — Pi then handles auth headers, streaming, retries, and tool-calling. The Responses API path preserves reasoning items across turns for reasoning-capable models, while the extension still auto-refreshes the model list from <code>GET /v1/models</code> so the menu reflects what your pinned peer can serve.',
    ],
    install: [
      {
        label: 'Install Pi itself (the coding agent CLI)',
        command: 'npm install -g @mariozechner/pi-coding-agent',
        note:
          'Pi requires Node.js 20+. The binary is `pi`. Verify with `pi --version`. Without any extensions, Pi can already talk to Claude / GPT / Gemini / Groq / etc. via API key or OAuth — the AntSeed extension below is what teaches it to route through your local buyer proxy.',
      },
      {
        label: 'Install the AntSeed extension into Pi',
        command: 'pi install git:github.com/AntSeed/pi-antseed',
        note:
          'Pi extensions install from a git URL or a local path. Alternatives: `pi -e git:github.com/AntSeed/pi-antseed` runs the extension once without installing, useful for trying it out. `pi install ./pi-antseed` works from a local clone.',
      },
      {
        label: 'Reload Pi so the new provider is picked up',
        command: '/reload',
        note:
          'Run this inside the Pi REPL (after typing `pi` to launch it). It re-scans extensions, skills, prompt templates, keybindings, and context files. A full restart works too.',
      },
    ],
    configure: [
      {
        kind: 'env',
        vars: {
          ANTSEED_BASE_URL: `http://localhost:${ANT_PORT}/v1`,
        },
      },
      {
        kind: 'gui',
        instructions:
          'No GUI config needed in the common case — the extension reads `ANTSEED_BASE_URL` (default `http://localhost:8377/v1`) and discovers models from the pinned peer automatically. Only set `ANTSEED_API_KEY` if you front the buyer proxy with your own auth layer, or `ANTSEED_MODELS="id1,id2"` to skip discovery and register a fixed list.',
      },
    ],
    modelHints: {
      suggested: ['minimax-m2.7', 'claude-sonnet-4-6', 'deepseek-v4-flash', 'qwen3-coder-480b'],
      note:
        'The extension auto-discovers from `GET /v1/models` after Pi loads, so anything your pinned peer advertises shows up under `antseed/...`. After re-pinning a different peer, run `/reload` in Pi to refresh the model list.',
    },
    test: [
      {
        label: 'Launch Pi',
        command: 'pi',
        note:
          'You\'ll see Pi\'s startup header, which lists loaded extensions. Look for `antseed` (or `pi-antseed`) in that list — if it\'s there, the extension loaded successfully.',
      },
      {
        label: 'Open the model picker and pick an AntSeed-routed model',
        command: '/model',
        note:
          'Or press Ctrl+L. The picker is fuzzy-searchable; type "antseed" to filter. You should see entries like `antseed/claude-sonnet-4-6`, `antseed/deepseek-v4-flash`, etc. — one for each service your pinned peer advertises.',
      },
      {
        label: 'Or switch directly via slash command',
        command: '/model antseed/minimax-m2.7',
        note:
          'Replace `minimax-m2.7` with any id from `curl http://localhost:8377/v1/models`. After this, every prompt routes through AntSeed → your pinned peer → the model.',
      },
    ],
    troubleshooting: [
      {
        problem: '`pi: command not found` after install',
        fix:
          'Your global npm bin is not on `PATH`. Run `npm prefix -g` to find it, then add `<that-path>/bin` to `PATH` in your shell rc. Or use a Node version manager (nvm, fnm, volta) which handles this automatically.',
      },
      {
        problem: '`antseed` doesn\'t appear in the model picker (`/model` or Ctrl+L)',
        fix:
          'The extension didn\'t load. Re-run `pi install git:github.com/AntSeed/pi-antseed`, restart Pi, and watch the startup header — it lists every loaded extension and surfaces load errors there.',
      },
      {
        problem: 'Picker only shows a few hard-coded `antseed/...` ids, not what my peer offers',
        fix:
          'Pi started before the buyer proxy was up, so the extension fell back to its built-in seed list. Make sure `antseed buyer start` is running and a peer is pinned, then run `/reload` inside Pi to refresh the model list.',
      },
      {
        problem: 'Empty `/v1/models` from the proxy',
        fix:
          'No peer is connected. Run `antseed network browse` to see options, then `antseed buyer connection set --peer <peerId>`. Or launch the proxy with `antseed buyer start --router <name>` for automatic peer selection.',
      },
      {
        problem: '5xx from the proxy mid-conversation',
        fix:
          'Usually means the pinned peer doesn\'t offer the model you asked for, or has just gone offline. Re-pin via `antseed buyer connection set --peer <peerId>` and `/reload` in Pi.',
      },
      {
        problem: 'Want to use a custom buyer proxy URL (remote host, custom port)',
        fix:
          'Set `ANTSEED_BASE_URL=http://your-host:8377/v1` in the shell that launches `pi`. The extension reads this on startup. If your proxy is fronted by auth, also set `ANTSEED_API_KEY=<token>`.',
      },
    ],
    links: [
      { label: 'Pi coding agent (npm)', href: 'https://www.npmjs.com/package/@mariozechner/pi-coding-agent' },
      { label: 'Pi source (badlogic/pi-mono)', href: 'https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent' },
      { label: 'pi-antseed extension', href: 'https://github.com/AntSeed/pi-antseed' },
    ],
    agentSummary:
      'Install Pi: `npm install -g @mariozechner/pi-coding-agent`. Install the AntSeed extension: `pi install git:github.com/AntSeed/pi-antseed`. Restart or `/reload`. The extension calls `pi.registerProvider("antseed", { api: "openai-responses", baseUrl: "http://localhost:8377/v1" })` and auto-discovers models from the pinned peer via GET /v1/models. Switch with `/model antseed/<service-id>`. Override base URL with `ANTSEED_BASE_URL` env var; auth with `ANTSEED_API_KEY`.',
  },

  /* ---------------- Autonomous agents ---------------- */
  {
    slug: 'openclaw',
    name: 'OpenClaw',
    logo: 'openclaw.svg',
    category: 'agent-platform',
    format: 'anthropic-messages',
    setupMinutes: 3,
    status: 'verified',
    oneLiner: 'Open-source autonomous agent runtime — register AntSeed as a custom provider in `openclaw.json`.',
    description: [
      '<strong>What OpenClaw is.</strong> OpenClaw is an open-source agent runtime for autonomous, long-running tasks (research, coding, web automation). It loads its provider catalog from <code>~/.openclaw/openclaw.json</code> — each entry is an HTTP endpoint plus a wire protocol (<code>anthropic-messages</code>, <code>openai-chat</code>, etc.) and a list of models.',
      '<strong>How AntSeed plugs in.</strong> Add a provider entry called <code>antseed</code> that points at <code>http://127.0.0.1:8377</code> with <code>api: "anthropic-messages"</code>. Each model id you list under that provider must be a service id your pinned peer advertises — OpenClaw will surface them in its model picker as <code>antseed/&lt;service-id&gt;</code>.',
      '<strong>Why a config entry instead of env vars.</strong> OpenClaw runs many providers in parallel (one per task, sometimes one per agent). A single base-URL override would force every agent through AntSeed; a named provider lets you mix AntSeed with hosted Anthropic, OpenAI, or local models on a per-agent basis.',
    ],
    install: [
      {
        label: 'Install OpenClaw',
        command: 'npm install -g openclaw',
        note: 'Verify with `openclaw --version`. The config file lives at `~/.openclaw/openclaw.json` and is created on first launch.',
      },
    ],
    configure: [
      {
        kind: 'file',
        path: '~/.openclaw/openclaw.json  (merge into the existing `models.providers` object)',
        language: 'json',
        snippet: `{
  "models": {
    "providers": {
      "antseed": {
        "baseUrl": "http://127.0.0.1:${ANT_PORT}",
        "apiKey": "antseed-p2p",
        "api": "anthropic-messages",
        "models": [
          {
            "id": "claude-sonnet-4-6",
            "name": "Claude Sonnet 4.6 (via AntSeed)",
            "reasoning": false,
            "input": ["text"],
            "contextWindow": 200000,
            "maxTokens": 8192
          },
          {
            "id": "deepseek-v4-flash",
            "name": "DeepSeek v4 Flash (via AntSeed)",
            "reasoning": false,
            "input": ["text"],
            "contextWindow": 128000,
            "maxTokens": 8192
          }
        ]
      }
    }
  }
}`,
      },
      {
        kind: 'code',
        language: 'bash',
        snippet: `# Set AntSeed as the default model for new agents:
openclaw config set agents.defaults.model.primary "antseed/claude-sonnet-4-6"`,
      },
    ],
    modelHints: {
      suggested: ['claude-sonnet-4-6', 'claude-opus-4-7', 'deepseek-v4-flash', 'gpt-oss-120b'],
      note:
        'Each `id` under `models[]` must match a service id from `curl http://127.0.0.1:8377/v1/models`. `apiKey` is required by OpenClaw\'s validator but ignored by the proxy — any non-empty string works. The `"antseed-p2p"` value is just convention.',
    },
    test: [
      {
        label: 'Confirm the proxy advertises the service ids you put in config',
        command: 'curl -s http://127.0.0.1:8377/v1/models | jq \'.data[].id\'',
        outputLabel: 'Example response',
        output: `"claude-opus-4-7"
"claude-sonnet-4-6"
"deepseek-v4-flash"
"gpt-oss-120b"`,
        note:
          'If a model id you listed in `openclaw.json` doesn\'t appear here, your pinned peer doesn\'t serve it. Pin a different peer or remove the entry.',
      },
      {
        label: 'Reload OpenClaw and check the provider list',
        command: 'openclaw config reload && openclaw providers list',
        note:
          'Or restart OpenClaw. You should see `antseed` with the model count you configured.',
      },
      {
        label: 'Run an agent against AntSeed',
        command: 'openclaw run "Summarize the README in this repo" --model antseed/claude-sonnet-4-6',
      },
    ],
    troubleshooting: [
      {
        problem: '`provider "antseed" not found` when launching an agent',
        fix:
          'JSON parse error in `openclaw.json`, or you put the entry in the wrong nesting level. The provider must live under `models.providers.antseed`. Run `openclaw config validate` to surface parse errors.',
      },
      {
        problem: 'OpenClaw lists `antseed/<id>` but every call returns `404 model_not_found`',
        fix:
          'The pinned peer doesn\'t advertise that service id. Run `antseed network peer <peerId>` to see what it actually offers, or pin a different peer with `antseed buyer connection set --peer <peerId>`.',
      },
      {
        problem: 'Streaming errors on long-running agents',
        fix:
          'AntSeed supports SSE streaming. If you see truncated responses, check that no proxy in front of OpenClaw is buffering (Cloudflare, nginx). The buyer proxy itself does not buffer.',
      },
      {
        problem: 'Agent stalls on first request after a deploy',
        fix:
          'AntSeed opens a payment channel on the first request to a new peer (one on-chain transaction, ~5–15s on Base). Subsequent requests reuse the channel. Pre-warm by running a quick `curl` before launching the agent.',
      },
    ],
    links: [
      { label: 'OpenClaw repo', href: 'https://github.com/openclaw/openclaw' },
      {
        label: 'AntSeed skill: openclaw-antseed (full walkthrough)',
        href: 'https://github.com/AntSeed/antseed/tree/main/skills/openclaw-antseed',
      },
    ],
    agentSummary:
      'Edit ~/.openclaw/openclaw.json: under models.providers, add an `antseed` entry with baseUrl=http://127.0.0.1:8377, api="anthropic-messages", apiKey="antseed-p2p", and a `models[]` array whose `id` values match service ids from GET /v1/models. Optionally `openclaw config set agents.defaults.model.primary "antseed/<id>"`. Reload with `openclaw config reload`.',
  },
  {
    slug: 'hermes',
    name: 'Hermes',
    logo: 'nousresearch.svg',
    category: 'agent-platform',
    format: 'openai-chat',
    setupMinutes: 3,
    status: 'verified',
    oneLiner: "Nous Research's agent framework — register AntSeed as a custom provider in `config.yaml`.",
    description: [
      '<strong>What Hermes is.</strong> Hermes is the agent framework from <a href="https://nousresearch.com/">Nous Research</a> (successor to OpenClaw\'s lineage). It\'s designed for autonomous, multi-step workflows — research agents, coding agents, swarms — and reads its model catalog from <code>~/.hermes/config.yaml</code>.',
      '<strong>How AntSeed plugs in.</strong> Add an entry under <code>custom_providers</code> with <code>base_url: http://127.0.0.1:8377/v1</code>, <code>api_mode: chat_completions</code>, and a list of <code>models</code>. Each model id must be a service id your pinned peer advertises. Then point <code>model.default</code> at the one you want as primary.',
      '<strong>One Hermes-specific gotcha.</strong> Some peers serve GPT-style models via the <code>openai-responses</code> protocol, which <em>requires</em> streaming. Hermes\' auxiliary calls (title generation, context compression) are non-streaming and will fail against those models with <code>HTTP 400: Stream must be set to true</code>. Pin auxiliary slots to a <code>chat_completions</code> model (config example below).',
    ],
    install: [
      {
        label: 'Install or build Hermes',
        command: '# Follow Nous Research setup at https://github.com/NousResearch/hermes-agent',
        note:
          'Hermes is typically run as a long-lived process (often under systemd on a server). The config file `~/.hermes/config.yaml` is read at startup — changes require a restart.',
      },
    ],
    configure: [
      {
        kind: 'file',
        path: '~/.hermes/config.yaml  (merge into your existing config)',
        language: 'yaml',
        snippet: `model:
  default: claude-sonnet-4-6
  provider: antseed

custom_providers:
  - name: antseed
    base_url: http://127.0.0.1:${ANT_PORT}/v1
    api_key: antseed-p2p
    api_mode: chat_completions
    models:
      - claude-sonnet-4-6
      - claude-opus-4-7
      - deepseek-v4-flash
      - gpt-oss-120b
      - minimax-m2.7

# Pin auxiliary calls to a chat_completions model so non-streaming
# requests (title generation, compression) don't break against
# openai-responses peers.
auxiliary:
  title_generation:
    provider: antseed
    model: minimax-m2.7
  compression:
    provider: antseed
    model: minimax-m2.7`,
      },
    ],
    modelHints: {
      suggested: ['claude-sonnet-4-6', 'minimax-m2.7', 'deepseek-v4-flash', 'gpt-oss-120b'],
      note:
        'Only ids listed under `models:` show up in Hermes\' picker — mirror it against `curl http://127.0.0.1:8377/v1/models` so you don\'t advertise models no peer serves. `model.provider: antseed` pins the default to this custom provider.',
    },
    test: [
      {
        label: 'Confirm the proxy advertises the same ids your config references',
        command: 'curl -s http://127.0.0.1:8377/v1/models | jq \'.data[].id\'',
        outputLabel: 'Example response',
        output: `"claude-opus-4-7"
"claude-sonnet-4-6"
"deepseek-v4-flash"
"gpt-oss-120b"
"minimax-m2.7"`,
      },
      {
        label: 'Restart Hermes to pick up the new provider',
        command: 'sudo systemctl restart hermes',
        note: 'Or whatever supervisor you use. Then check the journal: `sudo journalctl -u hermes --no-pager -n 30`.',
      },
      {
        label: 'After the first request, confirm a channel opened and is being metered',
        command: 'antseed buyer status\nantseed buyer metering',
        note:
          '`status` shows `Active channels: 1` once the first request settles (~5–15s on Base — one on-chain tx to open the channel). `metering` shows the per-peer token + USDC totals for each channel. To poll: `watch -n 1 antseed buyer metering`.',
      },
    ],
    troubleshooting: [
      {
        problem: '`HTTP 400: Stream must be set to true` from auxiliary calls',
        fix:
          'You\'re routing through a peer that serves the model via `openai-responses` (which requires streaming), but Hermes\' auxiliaries are non-streaming. Pin the `auxiliary.*` slots to a `chat_completions` model (see the config block above). Confirm a model\'s protocol with `antseed network peer <peerId>` — look for `protocols: openai-chat-completions` vs `openai-responses`.',
      },
      {
        problem: 'Hermes loads the provider but every call returns `no_peer_pinned`',
        fix:
          'In the default manual flow AntSeed does not auto-select a peer — pin one with `antseed buyer connection set --peer <peerId>`, send `x-antseed-pin-peer` per request, or start the buyer with a router plugin. The session pin survives buyer-proxy restarts (it\'s persisted to `~/.antseed/buyer.state.json`).',
      },
      {
        problem: 'Hermes runs on a remote host and can\'t reach `127.0.0.1:8377`',
        fix:
          'Either run the buyer proxy on the same host as Hermes (recommended — keeps the hot signing key local), or expose the proxy via SSH tunnel: `ssh -N -L 127.0.0.1:8377:127.0.0.1:8377 user@hermes-host`. Do not bind the buyer proxy to a public interface.',
      },
      {
        problem: 'Want to swap the routed model without restarting AntSeed',
        fix:
          'Edit `model.default` (and `models:` if needed) in `config.yaml`, re-pin a peer that serves it (`antseed buyer connection set --peer <peerId>`), then `sudo systemctl restart hermes`. The buyer proxy stays up; no contract calls.',
      },
    ],
    links: [
      { label: 'Hermes Agent (Nous Research)', href: 'https://github.com/NousResearch/hermes-agent' },
      {
        label: 'AntSeed skill: hermes-antseed (full walkthrough including systemd, remote hosts, payment portal)',
        href: 'https://github.com/AntSeed/antseed/tree/main/skills/hermes-antseed',
      },
    ],
    agentSummary:
      'Edit ~/.hermes/config.yaml: add a `custom_providers` entry named `antseed` with base_url=http://127.0.0.1:8377/v1, api_mode=chat_completions, api_key="antseed-p2p", and a `models:` list whose ids match service ids from GET /v1/models. Set `model.default` to one of those ids and `model.provider: antseed`. Pin `auxiliary.title_generation.model` and `auxiliary.compression.model` to a chat_completions model to avoid streaming errors against openai-responses peers.',
  },

  /* ---------------- (Additional frameworks) ---------------- */
  {
    slug: 'genlayer-studio',
    name: 'GenLayer Studio',
    logo: 'genlayer.svg',
    glyph: 'G',
    category: 'framework',
    format: 'openai-chat',
    setupMinutes: 5,
    status: 'verified',
    oneLiner: 'Use AntSeed as an inference provider inside GenLayer Studio validators.',
    description: [
      '<strong>What GenLayer Studio is.</strong> Studio runs <em>Intelligent Contract</em> validators that consult LLMs to reach consensus. Each validator is configured with a provider entry that has a <code>provider</code> name, a <code>plugin</code> (one of <code>openai-compatible</code> / <code>anthropic</code> / <code>google</code> / <code>ollama</code> / <code>custom</code>), a <code>model</code> id, and a <code>plugin_config</code> with <code>api_url</code> and <code>api_key_env_var</code>.',
      '<strong>How AntSeed plugs in.</strong> Drop one JSON file per model into <code>backend/node/create_nodes/default_providers/</code> with <code>plugin: "openai-compatible"</code> and <code>api_url: "http://host.docker.internal:8377"</code>. Studio\'s openai-compatible plugin appends <code>/v1/chat/completions</code> automatically, so the buyer proxy receives a standard OpenAI Chat request and routes it to your pinned peer. Mirror the existing LibertAI entry (PR #1526) — it is the closest analogue: an openai-compatible host with a hosted base URL replaced by your local proxy.',
      '<strong>Why <code>host.docker.internal</code>, not <code>localhost</code>.</strong> Studio\'s backend runs in Docker via <code>genlayer up</code>. From inside the container, <code>localhost</code> means the container itself, not your host machine — it cannot reach the AntSeed buyer proxy on the host. Mac/Windows Docker exposes the host as <code>host.docker.internal</code>; on Linux you must add <code>extra_hosts: ["host.docker.internal:host-gateway"]</code> to the backend service in <code>docker-compose.yml</code> or run with <code>--network=host</code>.',
    ],
    prereqs: [
      'GenLayer Studio cloned and running locally with `genlayer up` (see https://docs.genlayer.com/developers/intelligent-contracts/tools/genlayer-studio)',
    ],
    install: [
      {
        label: 'On Linux only — make `host.docker.internal` resolve from inside the backend container',
        language: 'yaml',
        command: `# docker-compose.yml — patch the backend (jsonrpc) service
services:
  jsonrpc:
    extra_hosts:
      - "host.docker.internal:host-gateway"`,
        note: 'Mac and Windows Docker Desktop already expose the host as `host.docker.internal` automatically — skip this step on those platforms. Restart with `genlayer up --reset` after editing.',
      },
    ],
    configure: [
      {
        kind: 'file',
        path: 'backend/node/create_nodes/default_providers/antseed_claude-sonnet-4-6.json',
        language: 'json',
        snippet: `{
  "provider": "antseed",
  "plugin": "openai-compatible",
  "model": "claude-sonnet-4-6",
  "config": {},
  "plugin_config": {
    "api_key_env_var": "ANTSEED_API_KEY",
    "api_url": "http://host.docker.internal:8377"
  }
}`,
      },
      {
        kind: 'file',
        path: 'backend/node/create_nodes/default_providers/antseed_deepseek-v4-flash.json',
        language: 'json',
        snippet: `{
  "provider": "antseed",
  "plugin": "openai-compatible",
  "model": "deepseek-v4-flash",
  "config": {},
  "plugin_config": {
    "api_key_env_var": "ANTSEED_API_KEY",
    "api_url": "http://host.docker.internal:8377"
  }
}`,
      },
      {
        kind: 'file',
        path: '.env  (next to docker-compose.yml)',
        language: 'bash',
        snippet: `# AntSeed authenticates with your local identity key, not this value.
# Studio's openai-compatible plugin still requires the env var to be set.
ANTSEED_API_KEY=antseed`,
      },
      {
        kind: 'file',
        path: 'backend/node/create_nodes/providers_schema.json  AND  frontend/src/assets/schemas/providers_schema.json',
        language: 'json',
        snippet: `// In each schema, add "antseed" to the provider enum's examples…
"provider": {
  "type": "string",
  "examples": ["ollama", "openrouter", "libertai", "antseed", …]
},

// …and add an if/then block locking provider:antseed to plugin:openai-compatible
{
  "if":   { "properties": { "provider": { "const": "antseed" } } },
  "then": { "properties": { "plugin":   { "const": "openai-compatible" } } }
}`,
        note: 'Both schema files must be kept in sync — the backend uses one for validation, the frontend uses the other for the UI dropdown. This is exactly what PR #1526 did for LibertAI.',
      },
    ],
    modelHints: {
      suggested: ['claude-sonnet-4-6', 'deepseek-v4-flash', 'gpt-oss-120b', 'qwen3-coder-480b'],
      note: 'Each provider JSON file pins exactly one `model`. Studio enumerates these into the validator-creation UI; pick services you know your pinned peer offers (check `antseed network peer <peerId> --json | jq \'.matchingServices[].service\'`). To expose more models later, drop in more `antseed_<model>.json` files — no schema edit needed.',
    },
    test: [
      {
        label: 'Restart Studio so it re-scans `default_providers/`',
        command: 'genlayer up --reset',
        note: '`get_default_providers()` in `backend/node/create_nodes/providers.py` reads every `*.json` in that folder once on boot, validates against `providers_schema.json`, and caches the result. Schema-validation errors abort startup with the offending file path — watch the logs.',
      },
      {
        label: 'In the Studio UI, create a new validator with provider "antseed"',
        note: 'You should see your `antseed_*.json` model ids in the dropdown. Save and trigger a contract that calls `genlayer.eq_principle.prompt(…)` — the request hits `http://host.docker.internal:8377/v1/chat/completions` on the AntSeed proxy and is forwarded to your pinned peer.',
      },
      {
        label: 'Confirm the validator call hit AntSeed',
        command: 'antseed buyer metering',
        note: 'Each validator call adds tokens + USDC to the channel for the peer you pinned. Run after a Studio request to see the totals update. To poll live: `watch -n 1 antseed buyer metering`.',
      },
    ],
    troubleshooting: [
      {
        problem: '`Error validating file … antseed_*.json` on `genlayer up`',
        fix:
          'The schema rejected your provider JSON. Most common cause: missing the if/then rule for `provider:antseed`, so it falls through with the wrong `plugin`. Add the rule to *both* `backend/.../providers_schema.json` and `frontend/.../providers_schema.json`. Run `genlayer up --reset` after editing.',
      },
      {
        problem: 'Validator hangs, then errors with `Connection refused` to `host.docker.internal:8377`',
        fix:
          'The backend container can\'t see your host. On Linux, add `extra_hosts: ["host.docker.internal:host-gateway"]` under the backend service in `docker-compose.yml` (see install step 2). On Mac/Windows, confirm Docker Desktop is running and the AntSeed proxy is up: `curl http://host.docker.internal:8377/v1/models` from inside the container with `docker compose exec jsonrpc curl …`.',
      },
      {
        problem: 'Validator returns `no_peer_pinned`',
        fix:
          'No peer is pinned in the buyer proxy. Run `antseed network browse`, pick one, then `antseed buyer connection set --peer <peerId>`. Alternatively, send a per-request `x-antseed-pin-peer` header by extending the openai-compatible plugin — not currently exposed in the standard schema, so session pin is the path of least resistance.',
      },
      {
        problem: '`404 model_not_found` from a validator using e.g. `claude-sonnet-4-6`',
        fix:
          'Your pinned peer doesn\'t advertise that service id. Run `antseed network peer <peerId> --json | jq \'.matchingServices[].service\'` to see what it does serve. Either pin a different peer or remove that `antseed_<model>.json` file.',
      },
      {
        problem: 'First call after a restart takes 5–15 seconds',
        fix:
          'AntSeed opens a payment channel on the first request to a new peer (one Base-mainnet transaction). Subsequent calls reuse the channel. Pre-warm with `curl -s http://localhost:8377/v1/chat/completions -d \'{"model":"<id>","messages":[{"role":"user","content":"hi"}]}\'` before triggering Studio.',
      },
    ],
    caveats: [
      'AntSeed is a local daemon, not a hosted endpoint. Every Studio operator must run AntStation or `antseed buyer start` on their own machine and fund their wallet — there is no central account.',
      'Free services exist on the AntSeed network (`in: 0, out: 0`), but using paid ones requires a USDC deposit on Base. AntStation guides users through this on first launch; the CLI exposes it as `antseed payments`.',
    ],
    links: [
      { label: 'GenLayer Studio repo', href: 'https://github.com/genlayerlabs/genlayer-studio' },
      { label: 'Studio docs', href: 'https://docs.genlayer.com/developers/intelligent-contracts/tools/genlayer-studio' },
      { label: 'Reference PR (LibertAI)', href: 'https://github.com/genlayerlabs/genlayer-studio/pull/1526' },
      { label: 'providers_schema.json (source of truth)', href: 'https://github.com/genlayerlabs/genlayer-studio/blob/main/backend/node/create_nodes/providers_schema.json' },
    ],
    agentSummary:
      'In GenLayer Studio: drop one JSON file per model into `backend/node/create_nodes/default_providers/` with `provider: "antseed"`, `plugin: "openai-compatible"`, `model: "<service-id>"`, and `plugin_config.api_url: "http://host.docker.internal:8377"` (NO `/v1` suffix — the plugin appends it). Add `"antseed"` to the provider enum and an if/then rule to BOTH `backend/.../providers_schema.json` and `frontend/.../providers_schema.json`. Set `ANTSEED_API_KEY=antseed` in `.env`. Restart with `genlayer up --reset`. The user must run AntStation or `antseed buyer start` and pin a peer that serves the listed `model` ids.',
  },

  /* ---------------- Frameworks ---------------- */
  {
    slug: 'vercel-ai-sdk',
    name: 'Vercel AI SDK',
    glyph: '▲',
    category: 'framework',
    format: 'openai-chat',
    setupMinutes: 5,
    status: 'verified',
    oneLiner: "Use `@ai-sdk/openai-compatible` to call AntSeed from `generateText` / `streamText` / `generateObject`.",
    description: [
      '<strong>What the AI SDK is.</strong> Vercel\'s <code>ai</code> package is a provider-agnostic TypeScript toolkit for building LLM apps and agents. You pick a <em>provider</em> (a small adapter package), instantiate a model from it, and pass that model into one of the framework\'s primitives: <code>generateText</code>, <code>streamText</code>, <code>generateObject</code>, or <code>streamObject</code>. The AI SDK handles tool-calling, structured output, message history, and streaming for you.',
      '<strong>How AntSeed plugs in.</strong> AntSeed is OpenAI-Chat-compatible at <code>http://localhost:8377/v1</code>, so the right adapter is <code>@ai-sdk/openai-compatible</code> (not <code>@ai-sdk/openai</code>). The official OpenAI provider is locked to OpenAI\'s API surface and quietly drops third-party fields; the openai-compatible provider is the one Vercel\'s own docs recommend for proxies, gateways, and any non-OpenAI server that speaks Chat Completions. You point it at the AntSeed proxy with <code>baseURL</code> and pass any non-empty <code>apiKey</code> placeholder — the proxy authenticates with your local identity key, not with this header.',
      '<strong>Which model ids work.</strong> The first argument to the provider call is the AntSeed <em>service id</em> (e.g. <code>claude-sonnet-4-6</code>, <code>deepseek-v4-flash</code>). It must match a service your pinned peer advertises — confirm with <code>curl http://localhost:8377/v1/models</code>.',
    ],
    prereqs: ['Node.js 18 or newer'],
    install: [
      {
        label: 'Install the SDK and the openai-compatible provider',
        command: 'npm install ai @ai-sdk/openai-compatible zod',
        note: '`zod` is only needed if you call `generateObject` / `streamObject`. Skip it for plain text generation.',
      },
    ],
    configure: [
      {
        kind: 'code',
        language: 'typescript',
        snippet: `// antseed.ts — a single provider instance you can import everywhere
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

export const antseed = createOpenAICompatible({
  name: 'antseed',
  baseURL: 'http://localhost:8377/v1',
  apiKey: 'antseed', // any non-empty string — proxy ignores this header
  includeUsage: true, // surface token counts in streaming responses too
});`,
      },
      {
        kind: 'code',
        language: 'typescript',
        snippet: `// stream.ts
import { streamText } from 'ai';
import { antseed } from './antseed';

const result = streamText({
  model: antseed('claude-sonnet-4-6'), // an AntSeed service id
  prompt: 'Why is the sky blue?',
});

for await (const chunk of result.textStream) {
  process.stdout.write(chunk);
}

console.log('\\nusage:', await result.usage);`,
      },
      {
        kind: 'code',
        language: 'typescript',
        snippet: `// structured.ts — generateObject works the same way
import { generateObject } from 'ai';
import { z } from 'zod';
import { antseed } from './antseed';

const { object } = await generateObject({
  model: antseed('claude-sonnet-4-6'),
  schema: z.object({
    title: z.string(),
    bullets: z.array(z.string()).min(3).max(5),
  }),
  prompt: 'Summarize the AntSeed buyer-proxy README as a slide.',
});
console.log(object);`,
      },
    ],
    modelHints: {
      suggested: ['claude-sonnet-4-6', 'deepseek-v4-flash', 'gpt-oss-120b', 'qwen3-coder-480b'],
      note:
        'The string you pass to `antseed(\'<id>\')` is forwarded verbatim as `model` in the OpenAI Chat request. Run `curl -s http://localhost:8377/v1/models | jq \'.data[].id\'` to see exactly what your pinned peer offers.',
    },
    test: [
      {
        label: 'Run a smoke test with `tsx`',
        command: 'npx tsx stream.ts',
        outputLabel: 'Example output',
        output: `The sky is blue because shorter (blue) wavelengths of sunlight
scatter much more than longer (red) wavelengths in Earth's atmosphere…

usage: { promptTokens: 14, completionTokens: 78, totalTokens: 92 }`,
        note:
          'If you see `404 model_not_found`, the pinned peer does not advertise the id you passed. If you see `no_peer_pinned`, run `antseed buyer connection set --peer <peerId>` first — or send the per-request header (next step).',
      },
      {
        label: 'Per-request peer override (no session pin needed)',
        language: 'typescript',
        command: `// Use \`headers\` to fan out to different peers per call.
const result = streamText({
  model: antseed('claude-sonnet-4-6'),
  prompt: 'hi',
  headers: {
    'x-antseed-pin-peer': 'cccccccccccccccccccccccccccccccccccccccc',
  },
});`,
        note:
          'Useful when one Node process serves many tenants and you want each request routed to a different peer. The header overrides the session pin for that single call.',
      },
    ],
    troubleshooting: [
      {
        problem: 'TypeScript complains that `antseed` has no call signature',
        fix:
          'You imported from `@ai-sdk/openai` instead of `@ai-sdk/openai-compatible`. Switch the package — the SDK\'s official OpenAI provider is locked to OpenAI\'s service ids and rejects unknown ones.',
      },
      {
        problem: '`generateObject` returns malformed JSON',
        fix:
          'The AI SDK is strict about JSON Schema support. Pass `supportsStructuredOutputs: true` to `createOpenAICompatible` only if your pinned peer\'s service supports OpenAI-style structured outputs natively. If unsure, leave it off — the SDK falls back to tool-call-based JSON which works everywhere.',
      },
      {
        problem: '`includeUsage` is set but `result.usage` is undefined',
        fix:
          'Some upstream providers behind AntSeed do not emit usage on streamed responses. Try `generateText` instead of `streamText` for definitive token counts; otherwise run `antseed buyer metering` for the authoritative per-channel token + USDC totals AntSeed itself measured.',
      },
      {
        problem: 'Browser/edge runtime fails with `fetch` errors',
        fix:
          'The AntSeed proxy listens on `127.0.0.1:8377`, which is not reachable from a browser tab on a deployed site. The AI SDK is designed to run on the server (Route Handlers, Server Actions, edge functions on your own machine, or a Node process); don\'t call it from a client component when the model is AntSeed.',
      },
    ],
    links: [
      { label: 'AI SDK docs', href: 'https://ai-sdk.dev/docs' },
      {
        label: '@ai-sdk/openai-compatible provider docs',
        href: 'https://ai-sdk.dev/providers/openai-compatible-providers',
      },
      { label: '`ai` on npm', href: 'https://www.npmjs.com/package/ai' },
    ],
    agentSummary:
      "createOpenAICompatible({ name: 'antseed', baseURL: 'http://localhost:8377/v1', apiKey: 'antseed' }), then antseed('<service-id>') as the model. Use @ai-sdk/openai-compatible (NOT @ai-sdk/openai). Service ids come from GET http://localhost:8377/v1/models. Per-request peer override: pass headers: { 'x-antseed-pin-peer': '<peerId>' } in generateText/streamText.",
  },
  {
    slug: 'langchain-python',
    name: 'LangChain (Python)',
    logo: 'langchain.svg',
    glyph: 'L',
    category: 'framework',
    format: 'openai-chat',
    setupMinutes: 5,
    status: 'verified',
    oneLiner: 'Drop-in `ChatOpenAI(base_url=…)` — works in chains, LCEL, and LangGraph agents.',
    description: [
      '<strong>What LangChain is.</strong> LangChain is the Python framework for composing LLMs with tools, retrievers, memory, and agents. The chat-model interface is <code>BaseChatModel</code>; <code>ChatOpenAI</code> from <code>langchain-openai</code> is a concrete subclass that talks the OpenAI Chat Completions wire format.',
      '<strong>How AntSeed plugs in.</strong> Pass <code>base_url="http://localhost:8377/v1"</code> and any non-empty <code>api_key</code> to <code>ChatOpenAI</code>. Once you have an instance, every primitive that accepts a chat model — LCEL pipes (<code>prompt | llm | parser</code>), tool-calling agents, <code>create_react_agent</code>, LangGraph nodes, RAG chains, structured-output binding via <code>with_structured_output</code> — will route through AntSeed without any further changes.',
      '<strong>One thing to know.</strong> LangChain\'s <code>ChatOpenAI</code> is OpenAI-strict by design: it will not preserve non-standard response fields like <code>reasoning_content</code>, <code>reasoning</code>, or <code>reasoning_details</code> that some third-party servers emit. For chat, tool-calling, and structured output this is fine. If you specifically need a model\'s reasoning traces, consider using the AntSeed buyer proxy with the OpenAI Responses endpoint (<code>/v1/responses</code>) via a different provider package, or use a model that returns reasoning inline.',
    ],
    prereqs: ['Python 3.10 or newer'],
    install: [
      {
        label: 'Install LangChain and the OpenAI integration',
        command: 'pip install -U langchain langchain-openai',
      },
    ],
    configure: [
      {
        kind: 'code',
        language: 'python',
        snippet: `# antseed_llm.py — import this once, reuse everywhere.
from langchain_openai import ChatOpenAI

antseed = ChatOpenAI(
    model="claude-sonnet-4-6",          # an AntSeed service id
    base_url="http://localhost:8377/v1",
    api_key="antseed",                   # any non-empty string
    temperature=0.7,
    # max_completion_tokens=2048,        # uncomment for hard caps
)

print(antseed.invoke("Hello").content)`,
      },
      {
        kind: 'code',
        language: 'python',
        snippet: `# pipeline.py — LCEL chain. Identical to OpenAI; the swap is invisible.
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser
from antseed_llm import antseed

prompt = ChatPromptTemplate.from_messages([
    ("system", "You are a concise technical writer."),
    ("human", "Explain {topic} in one paragraph."),
])

chain = prompt | antseed | StrOutputParser()
print(chain.invoke({"topic": "payment channels"}))`,
      },
      {
        kind: 'code',
        language: 'python',
        snippet: `# tools.py — tool-calling agent. Works because AntSeed forwards OpenAI tool calls verbatim.
from langchain_core.tools import tool
from langgraph.prebuilt import create_react_agent
from antseed_llm import antseed

@tool
def get_weather(city: str) -> str:
    """Return the current weather for a city."""
    return f"It's 22°C and sunny in {city}."

agent = create_react_agent(antseed, [get_weather])
result = agent.invoke({
    "messages": [("user", "What's the weather in Lisbon?")]
})
print(result["messages"][-1].content)`,
      },
    ],
    modelHints: {
      suggested: ['claude-sonnet-4-6', 'deepseek-v4-flash', 'gpt-oss-120b', 'qwen3-coder-480b'],
      note:
        'Pick services whose `protocols` array includes `openai-chat-completions` (most do natively; the rest are translated automatically by `@antseed/api-adapter`). Tool calling and structured output rely on the service supporting OpenAI-style function-call syntax — confirm with a quick smoke test before building large agents.',
    },
    test: [
      {
        label: 'Run the basic example',
        command: 'python antseed_llm.py',
        outputLabel: 'Example output',
        output: 'Hello! How can I help you today?',
      },
      {
        label: 'Per-request peer override (no session pin needed)',
        language: 'python',
        command: `# extra_headers is forwarded as-is to the proxy.
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    model="claude-sonnet-4-6",
    base_url="http://localhost:8377/v1",
    api_key="antseed",
    extra_headers={
        "x-antseed-pin-peer": "cccccccccccccccccccccccccccccccccccccccc",
    },
)
print(llm.invoke("hi").content)`,
        note: 'Use this when a single Python process needs to fan out to different peers per call (multi-tenant, scheduled jobs, A/B tests across peers).',
      },
      {
        label: 'Verify it actually went through AntSeed',
        command: 'antseed buyer metering',
        note: '`buyer metering` reads the local SQLite log and prints per-channel token + USDC totals. After your `python` call, the channel for the peer you pinned should show non-zero input/output tokens. (`buyer status` is a snapshot view — it shows the active-channel count but not per-call usage.)',
      },
    ],
    troubleshooting: [
      {
        problem: '`openai.NotFoundError: 404 … model_not_found`',
        fix:
          'The pinned peer does not advertise the id you passed. Confirm with `curl http://localhost:8377/v1/models | jq` and either pin a different peer or change the `model=` argument.',
      },
      {
        problem: '`openai.APIConnectionError: Connection refused`',
        fix:
          'The buyer proxy is not running. Start it with `antseed buyer start` (or open AntStation desktop). Confirm `curl http://localhost:8377/v1/models` works before retrying from Python.',
      },
      {
        problem: '`with_structured_output` returns the right schema but empty fields',
        fix:
          'Either the model behind the pinned peer does not support OpenAI tool-call syntax, or you used `method="json_mode"` against a service that does not honor it. Try `method="function_calling"` (the default), and prefer services tagged `coding` or `tools` in `antseed network peer <peerId> --json`.',
      },
      {
        problem: 'Streaming with `stream=True` truncates mid-response',
        fix:
          'A buffering proxy (nginx, Cloudflare) sits between your code and the buyer proxy. The AntSeed proxy itself does not buffer SSE. Either bypass the intermediate proxy or set its buffering off (`proxy_buffering off;` in nginx).',
      },
      {
        problem: 'Reasoning traces missing on a model you know emits them',
        fix:
          'See the third paragraph above: `langchain-openai` does not preserve non-standard response fields. For first-class reasoning support, route the request through the OpenAI Responses endpoint (`POST /v1/responses` on the proxy) using a Responses-aware client, or pick a model that puts reasoning inline in `content`.',
      },
    ],
    links: [
      { label: 'LangChain docs', href: 'https://python.langchain.com' },
      {
        label: 'ChatOpenAI integration page',
        href: 'https://docs.langchain.com/oss/python/integrations/chat/openai',
      },
      { label: '`langchain-openai` on PyPI', href: 'https://pypi.org/project/langchain-openai/' },
    ],
    agentSummary:
      "ChatOpenAI(model='<service-id>', base_url='http://localhost:8377/v1', api_key='antseed') from langchain-openai. Drops into LCEL, create_react_agent, RAG, with_structured_output. Per-request peer override: extra_headers={'x-antseed-pin-peer': '<peerId>'}. Service ids come from GET http://localhost:8377/v1/models. Reasoning traces (reasoning_content, etc.) are NOT preserved by ChatOpenAI — use the Responses endpoint for those.",
  },

  /* ---------------- Raw HTTP ---------------- */
  {
    slug: 'curl',
    name: 'curl / raw HTTP',
    glyph: '$',
    category: 'cli',
    format: 'multi',
    setupMinutes: 1,
    status: 'verified',
    oneLiner: 'Hit the proxy with plain HTTP — useful for scripts and debugging.',
    description: [
      'The buyer proxy is a vanilla HTTP server. Anything that can issue an HTTP POST works. Three endpoints are exposed:',
      '• `POST /v1/messages` — Anthropic Messages format\n• `POST /v1/chat/completions` — OpenAI Chat Completions\n• `POST /v1/responses` — OpenAI Responses API',
    ],
    install: [],
    configure: [
      {
        kind: 'code',
        language: 'bash',
        snippet: `# Anthropic format
curl http://localhost:8377/v1/messages \\
  -H 'content-type: application/json' \\
  -d '{
    "model": "claude-sonnet-4-6",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello"}]
  }'

# OpenAI Chat format
curl http://localhost:8377/v1/chat/completions \\
  -H 'content-type: application/json' \\
  -d '{
    "model": "deepseek-v3.1",
    "messages": [{"role": "user", "content": "Hello"}]
  }'`,
      },
    ],
    agentSummary:
      'POST JSON to http://localhost:8377/v1/messages, /v1/chat/completions, or /v1/responses. No Authorization header required.',
  },
];

/* ------------------------------------------------------------------ *
 * Helpers consumed by the connect pages and skill.md generator.
 * ------------------------------------------------------------------ */

export const CATEGORY_LABELS: Record<IntegrationCategory, string> = {
  'coding-agent': 'Coding agents',
  'agent-platform': 'Autonomous agents',
  framework: 'Frameworks',
  cli: 'Raw HTTP',
};

export const CATEGORY_TAGLINES: Record<IntegrationCategory, string> = {
  'coding-agent':
    "Drop-in for Claude Code, Codex, and friends. Set one env var, keep your existing workflow.",
  'agent-platform':
    "Long-running, autonomous workloads. Agents pick providers by price, latency, and reputation — no API keys, no SaaS account.",
  framework:
    "LangChain, Vercel AI SDK, GenLayer Studio, and other multi-provider frameworks. Add AntSeed as one of the providers.",
  cli:
    "The lowest-level contract. Use this if you're scripting, debugging, or building a new integration.",
};

/** Order in which category sections render on the hub. */
export const CATEGORY_ORDER: IntegrationCategory[] = [
  'coding-agent',
  'agent-platform',
  'framework',
  'cli',
];

export const FORMAT_LABELS: Record<IntegrationFormat, string> = {
  'anthropic-messages': 'Anthropic Messages',
  'openai-chat': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses',
  multi: 'Multi-format',
};

/** Short variants used on small surfaces like cards. */
export const FORMAT_SHORT: Record<IntegrationFormat, string> = {
  'anthropic-messages': 'Anthropic',
  'openai-chat': 'OpenAI',
  'openai-responses': 'OpenAI Resp',
  multi: 'Multi',
};

export const STATUS_LABELS: Record<IntegrationStatus, string> = {
  verified: 'Verified',
  community: 'Community',
  'coming-soon': 'Coming soon',
};

export function bySlug(slug: string): Integration | undefined {
  return integrations.find((i) => i.slug === slug);
}

export const ANT_PROXY_PORT = ANT_PORT;
export const ANT_PROXY_URL = `http://localhost:${ANT_PORT}`;
