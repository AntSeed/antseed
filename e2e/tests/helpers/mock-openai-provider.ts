import type { Provider, SerializedHttpRequest, SerializedHttpResponse } from '@antseed/node';

export class MockOpenAIChatProvider implements Provider {
  readonly name = 'openai';
  readonly services = ['gpt-4.1'];
  readonly pricing = {
    defaults: {
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 1,
    },
  };
  readonly maxConcurrency = 5;
  private _active = 0;
  public requestCount = 0;
  public lastRequest: SerializedHttpRequest | null = null;

  async handleRequest(req: SerializedHttpRequest): Promise<SerializedHttpResponse> {
    this._active++;
    this.requestCount++;
    this.lastRequest = req;
    try {
      const requestBody = JSON.parse(new TextDecoder().decode(req.body)) as Record<string, unknown>;
      const firstMessage = Array.isArray(requestBody.messages) && requestBody.messages[0] && typeof requestBody.messages[0] === 'object'
        ? (requestBody.messages[0] as Record<string, unknown>)
        : null;
      const systemText = typeof firstMessage?.content === 'string' ? firstMessage.content : null;
      const text = systemText === 'stream please'
        ? 'Hello from OpenAI stream mock!'
        : 'Hello from OpenAI mock!';

      const body = JSON.stringify({
        id: 'chatcmpl_test_1',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'gpt-4.1',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: text,
            },
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 6,
          total_tokens: 16,
        },
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
