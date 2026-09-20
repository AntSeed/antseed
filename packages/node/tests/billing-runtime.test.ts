import { describe, expect, it } from "vitest";
import {
  captureUnitBillingContext,
  computeFinalUnitBilling,
  isFreeUnitBillingModel,
  unitUsageFromReport,
  validateUnitBillingModelV2,
  validateUnitBillingUsage,
  validateUnitBillingUsageReportV2,
} from "../src/billing/unit.js";
import type {
  UnitBillingContext,
  UnitBillingModelV2,
} from "../src/types/billing.js";
import type { SerializedHttpRequest } from "../src/types/http.js";

const imageContext: UnitBillingContext = {
  sellerPeerId: "a".repeat(40),
  provider: "openai",
  service: "gpt-image-2",
  serviceApiProtocol: "openai-images",
  maxQuantity: 1,
};

const imageModel: UnitBillingModelV2 = { version: 2, priceMicroUsdc: "40000" };

describe("unit billing runtime", () => {
  it("rejects positive billingUsage cost when buyer recomputation is zero", () => {
    expect(() => validateUnitBillingUsage({ version: 2, priceMicroUsdc: '0' }, imageContext, { version: 2, quantity: '1' }, 40000n, 1.4, { quantity: 1 })).toThrow('exceeds');
  });

  it("computes final output image cost from delivered response images", () => {
    const result = computeFinalUnitBilling(
      imageModel,
      { ...imageContext, maxQuantity: 4 },
      {
        requestId: "req-1",
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode(JSON.stringify({
          data: [{ b64_json: "first" }, { url: "https://example.test/second.png" }],
        })),
      },
    );

    expect(result.usage.quantity).toBe(2);
    expect(result.costUsdc).toBe(80_000n);
    expect(result.billingUsage).toEqual({
      version: 2,
      quantity: "2",
    });
  });

  it("rejects over-delivered quantities rather than authorizing an ambiguous result", () => {
    expect(() => computeFinalUnitBilling(imageModel, imageContext, { requestId: 'request', statusCode: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ data: [{ b64_json: 'one' }, { b64_json: 'two' }] })) })).toThrow('limit');
  });

  it("does not bill placeholder response entries as delivered images", () => {
    const result = computeFinalUnitBilling(
      imageModel,
      { ...imageContext, maxQuantity: 2 },
      {
        requestId: "req-placeholder",
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode(JSON.stringify({ data: [{}, { b64_json: "" }] })),
      },
    );

    expect(result.usage.quantity).toBe(0);
    expect(result.costUsdc).toBe(0n);
  });

  it("rejects seller unit usage above the requested output image count", () => {
    expect(() =>
      validateUnitBillingUsage(
        imageModel,
        imageContext,
        {
          version: 2,
          quantity: "2",
        },
        80_000n,
        1.4,
      ),
    ).toThrow(/request limit/);
  });

  it("rejects seller unit usage above what the response actually delivered", () => {
    const context: UnitBillingContext = {
      ...imageContext,
      maxQuantity: 4,
    };

    expect(() =>
      validateUnitBillingUsage(
        imageModel,
        context,
        {
          version: 2,
          quantity: "4",
        },
        160_000n,
        1.4,
        { quantity: 1 },
      ),
    ).toThrow(/observed/);
  });

  it("rejects positive seller unit usage when the observed response delivered nothing", () => {
    expect(() =>
      validateUnitBillingUsage(
        imageModel,
        imageContext,
        {
          version: 2,
          quantity: "1",
        },
        40_000n,
        1.4,
        { quantity: 0 },
      ),
    ).toThrow(/observed/);
  });

  it("accepts seller unit usage matching the observed response", () => {
    expect(
      validateUnitBillingUsage(
        imageModel,
        imageContext,
        {
          version: 2,
          quantity: "1",
        },
        40_000n,
        1.4,
        { quantity: 1 },
      ),
    ).toBe(40_000n);
  });

  it("rejects positive cost claims before the buyer observed the delivered response", () => {
    expect(() =>
      validateUnitBillingUsage(
        imageModel,
        imageContext,
        {
          version: 2,
          quantity: "1",
        },
        40_000n,
        1.4,
        undefined,
      ),
    ).toThrow(/before the buyer observed/);
  });

  it("accepts zero-cost claims without observed usage", () => {
    expect(
      validateUnitBillingUsage(
        imageModel,
        imageContext,
        {
          version: 2,
          quantity: "0",
        },
        0n,
        1.4,
        undefined,
      ),
    ).toBe(0n);
  });

  it("rejects non-canonical and unsafe unit count strings", () => {
    expect(
      validateUnitBillingUsageReportV2({
        version: 2,
        quantity: "1e3",
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "canonical safe non-negative integer decimal string",
        ),
      ]),
    );

    expect(
      validateUnitBillingUsageReportV2({
        version: 2,
        quantity: "01",
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "canonical safe non-negative integer decimal string",
        ),
      ]),
    );

    expect(() =>
      unitUsageFromReport({
        version: 2,
        quantity: String(Number.MAX_SAFE_INTEGER + 1),
      }),
    ).toThrow(/safe non-negative/);
  });

  it("does not classify malformed non-finite prices as free", () => {
    const model = { version: 2, priceMicroUsdc: String(Math.round((Number.NaN) * 1_000_000)) } as UnitBillingModelV2;

    expect(isFreeUnitBillingModel(model)).toBe(false);
    expect(validateUnitBillingModelV2(model)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("canonical uint32"),
      ]),
    );
  });

  it("captures request-owned unit context without protocol billing vocabulary in api-adapter facts", () => {
    const request: SerializedHttpRequest = {
      requestId: "req-image",
      method: "POST",
      path: "/v1/images/generations",
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode(JSON.stringify({
        model: "gpt-image-2",
        prompt: "cube",
        size: "1024x1024",
        quality: "low",
      })),
    };

    const captured = captureUnitBillingContext({
      sellerPeerId: "a".repeat(40),
      provider: "openai",
      service: "gpt-image-2",
      serviceApiProtocol: "openai-images",
      request,
    });

    expect(captured.context).toMatchObject({
      serviceApiProtocol: "openai-images",
      maxQuantity: 1,
    });
    expect(captured.estimatedPromptTokens).toBe(1);
    expect(captured.requestUsage).toEqual({ quantity: 1 });
  });

  it("captures unit context from a multipart image edits request", () => {
    const boundary = "----antseedEditBoundary";
    const request: SerializedHttpRequest = {
      requestId: "req-image-edit",
      method: "POST",
      path: "/v1/images/edits",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body: new TextEncoder().encode([
        `--${boundary}`,
        'Content-Disposition: form-data; name="model"',
        "",
        "gpt-image-2",
        `--${boundary}`,
        'Content-Disposition: form-data; name="prompt"',
        "",
        "make the cube red",
        `--${boundary}`,
        'Content-Disposition: form-data; name="n"',
        "",
        "2",
        `--${boundary}`,
        'Content-Disposition: form-data; name="size"',
        "",
        "1024x1024",
        `--${boundary}`,
        'Content-Disposition: form-data; name="image"; filename="in.png"',
        "Content-Type: image/png",
        "",
        "\x89PNG-binary",
        `--${boundary}--`,
        "",
      ].join("\r\n")),
    };

    const captured = captureUnitBillingContext({
      sellerPeerId: "a".repeat(40),
      provider: "openai",
      service: "gpt-image-2",
      serviceApiProtocol: "openai-images",
      request,
    });

    expect(captured.context).toMatchObject({
      serviceApiProtocol: "openai-images",
      maxQuantity: 2,
    });
    expect(captured.estimatedPromptTokens).toBe(4);
    expect(captured.requestUsage).toEqual({ quantity: 2 });
  });

  it("defaults missing image quantity to one and rejects invalid explicit quantities", () => {
    const request: SerializedHttpRequest = { requestId: 'request', method: 'POST', path: '/v1/images/generations', headers: {}, body: new TextEncoder().encode(JSON.stringify({ model: 'image' })) };
    const args = { ...imageContext, request };
    expect(captureUnitBillingContext(args).context.maxQuantity).toBe(1);
    request.body = new TextEncoder().encode(JSON.stringify({ n: 0 }));
    expect(() => captureUnitBillingContext(args)).toThrow('positive safe integer');
  });
});
