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

export class MockOpenAIImageProvider implements Provider {
  readonly name = 'openai';
  readonly services = ['gpt-image-2'];
  readonly pricing = {
    defaults: {
      inputUsdPerMillion: 5,
      outputUsdPerMillion: 40,
    },
  };
  readonly serviceApiProtocols = {
    'gpt-image-2': ['openai-images' as any],
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
      const body = JSON.stringify({
        created: Math.floor(Date.now() / 1000),
        data: [
          {
            b64_json: Buffer.from('mock-image-bytes').toString('base64'),
          },
        ],
        usage: {
          input_tokens: 15,
          input_tokens_details: {
            image_tokens: 0,
            text_tokens: 15,
          },
          output_tokens: 196,
          output_tokens_details: {
            image_tokens: 196,
            text_tokens: 0,
          },
          total_tokens: 211,
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
