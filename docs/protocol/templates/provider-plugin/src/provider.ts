// Note: if working from source, build @antseed/node first (npm run build in the node/ directory).
import type { Provider } from '@antseed/node';
import type { SerializedHttpRequest, SerializedHttpResponse } from '@antseed/node/types';

/**
 * EchoProvider — a minimal Provider that echoes the request back.
 *
 * Use this as a starting point. Replace handleRequest() with real
 * inference logic (e.g., forward to Anthropic, OpenAI, or a local LLM).
 */
export class EchoProvider implements Provider {
  readonly name = 'echo';
  readonly services = ['echo-v1'];
  readonly pricing = {
    defaults: {
      inputUsdPerMillion: 0,
      outputUsdPerMillion: 0,
    },
  };
  readonly maxConcurrency = 10;

  private _currentRequests = 0;

  // Config is passed from the plugin's configKeys → environment variables.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_config: Record<string, string>) {}

  async handleRequest(req: SerializedHttpRequest): Promise<SerializedHttpResponse> {
    this._currentRequests++;
    try {
      // Echo the request body back as the response
      const echoBody = JSON.stringify({
        echo: true,
        method: req.method,
        path: req.path,
        headers: req.headers,
        bodyLength: req.body.length,
        body: new TextDecoder().decode(req.body),
      });

      return {
        requestId: req.requestId,
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(echoBody),
      };
    } finally {
      this._currentRequests--;
    }
  }

  getCapacity(): { current: number; max: number } {
    return { current: this._currentRequests, max: this.maxConcurrency };
  }
}
