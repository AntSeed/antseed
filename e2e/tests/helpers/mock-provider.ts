import type { Provider, SerializedHttpRequest, SerializedHttpResponse } from '@antseed/node';

export class MockAnthropicProvider implements Provider {
  readonly name = 'anthropic';
  readonly models = ['claude-sonnet-4-5-20250929'];
  readonly pricing = {
    defaults: {
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 1,
    },
  };
  readonly maxConcurrency = 5;
  private _active = 0;
  public requestCount = 0;

  async handleRequest(req: SerializedHttpRequest): Promise<SerializedHttpResponse> {
    this._active++;
    this.requestCount++;
    try {
      const body = JSON.stringify({
        id: 'msg_test_' + Date.now(),
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello from mock provider!' }],
        model: 'claude-sonnet-4-5-20250929',
        usage: { input_tokens: 100, output_tokens: 20 },
      });
      return {
        requestId: req.requestId,
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(body),
      };
    } finally {
      this._active--;
    }
  }

  getCapacity() {
    return { current: this._active, max: this.maxConcurrency };
  }
}
