import { describe, expect, it } from "vitest";
import {
  captureBillingContext,
  captureSellerBillingContext,
  computeFinalCost,
  validateBillingUsageReport,
} from "../src/billing/runtime.js";
import { resolveBillingMode } from "../src/billing/mode.js";
import {
  isFreeBillingModel,
  usageFromBillingReport,
  validateServiceBillingModelV1,
  validateBillingUsageReportV1,
} from "../src/billing/evaluator.js";
import type {
  BuyerRequestBillingContext,
  ServiceBillingModelV1,
} from "../src/types/billing.js";
import type { SerializedHttpRequest } from "../src/types/http.js";
import type { PeerInfo } from "../src/types/peer.js";

const imageContext: BuyerRequestBillingContext = {
  sellerPeerId: "a".repeat(40),
  provider: "openai",
  service: "gpt-image-2",
  serviceApiProtocol: "openai-images",
  attributes: { model: "gpt-image-2" },
  meterAttributes: { output_images: { size: "1024x1024", quality: "low" } },
  meterLimits: { output_images: 1 },
};

describe("billing runtime", () => {
  it("keeps token pricing active for image requests", () => {
    const imageResolution = resolveBillingMode({
      serviceApiProtocol: "openai-images",
      tokenPricing: { inputUsdPerMillion: 10, outputUsdPerMillion: 20 },
    });

    expect(imageResolution).toMatchObject({
      kind: "token",
      pricing: { inputUsdPerMillion: 10, outputUsdPerMillion: 20 },
    });

    const explicitFreeImageResolution = resolveBillingMode({
      serviceApiProtocol: "openai-images",
      unitModel: { version: 1, components: [] },
    });

    expect(explicitFreeImageResolution).toMatchObject({
      kind: "free",
    });

    const missingImageModelResolution = resolveBillingMode({
      serviceApiProtocol: "openai-images",
    });

    expect(missingImageModelResolution).toMatchObject({
      kind: "unsupported",
      reason: "missing-pricing",
    });

    const tokenResolution = resolveBillingMode({
      serviceApiProtocol: "openai-chat-completions",
      tokenPricing: { inputUsdPerMillion: 10, outputUsdPerMillion: 20 },
    });

    expect(tokenResolution.kind).toBe("token");
  });

  it("rejects positive billingUsage cost when buyer recomputation is zero", () => {
    const model: ServiceBillingModelV1 = {
      version: 1,
      components: [
        {
          meter: "output_images",
          unit: "per_unit",
          priceUsd: 0.04,
          match: { size: "1024x1024" },
        },
      ],
    };
    const mismatchedContext: BuyerRequestBillingContext = {
      ...imageContext,
      meterAttributes: { output_images: { size: "256x256" } },
    };

    expect(() =>
      validateBillingUsageReport(
        model,
        mismatchedContext,
        {
          version: 1,
          meters: { output_images: "1" },
          attributes: { model: "gpt-image-2" },
          meterAttributes: { output_images: { size: "1024x1024" } },
          costUsdc: "40000",
        },
        1.4,
      ),
    ).toThrow(/recomputed to zero/);
  });

  it("caps final output image cost to the requested output image count", () => {
    const model: ServiceBillingModelV1 = {
      version: 1,
      components: [
        {
          meter: "output_images",
          unit: "per_unit",
          priceUsd: 0.04,
          match: { size: "1024x1024" },
        },
      ],
    };

    const result = computeFinalCost(
      model,
      imageContext,
      {
        requestId: "req-1",
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode(JSON.stringify({ data: [{}, {}] })),
      },
      {
        requestedOutputImages: 4,
        attributes: imageContext.attributes,
        meterAttributes: imageContext.meterAttributes,
      },
    );

    expect(result.usage.meters.output_images).toBe(2);
    expect(result.costUsdc).toBe(80_000n);
  });

  it("caps over-delivered output images to the request limit", () => {
    const model: ServiceBillingModelV1 = {
      version: 1,
      components: [
        {
          meter: "output_images",
          unit: "per_unit",
          priceUsd: 0.04,
          match: { size: "1024x1024" },
        },
      ],
    };

    const result = computeFinalCost(
      model,
      imageContext,
      {
        requestId: "req-1",
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode(JSON.stringify({ data: [{}, {}] })),
      },
      {
        requestedOutputImages: 1,
        attributes: imageContext.attributes,
        meterAttributes: imageContext.meterAttributes,
      },
    );

    expect(result.usage.meters.output_images).toBe(1);
    expect(result.costUsdc).toBe(40_000n);
  });

  it("rejects seller billingUsage above the requested output image count", () => {
    const model: ServiceBillingModelV1 = {
      version: 1,
      components: [
        {
          meter: "output_images",
          unit: "per_unit",
          priceUsd: 0.04,
          match: { size: "1024x1024" },
        },
      ],
    };

    expect(() =>
      validateBillingUsageReport(
        model,
        imageContext,
        {
          version: 1,
          meters: { output_images: "2" },
          costUsdc: "80000",
        },
        1.4,
      ),
    ).toThrow(/request allowed 1/);
  });

  it("rejects non-canonical and unsafe billing meter strings", () => {
    expect(
      validateBillingUsageReportV1({
        version: 1,
        meters: { output_images: "1e3" },
        costUsdc: "0",
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "canonical non-negative integer decimal string",
        ),
      ]),
    );

    expect(
      validateBillingUsageReportV1({
        version: 1,
        meters: { output_images: "01" },
        costUsdc: "0",
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "canonical non-negative integer decimal string",
        ),
      ]),
    );

    expect(() =>
      usageFromBillingReport({
        version: 1,
        meters: { output_images: String(Number.MAX_SAFE_INTEGER + 1) },
        costUsdc: "0",
      }),
    ).toThrow(/maximum safe integer/);
  });

  it("does not classify malformed non-finite prices as free", () => {
    const model = {
      version: 1,
      components: [
        { meter: "output_images", unit: "per_unit", priceUsd: Number.NaN },
      ],
    } as ServiceBillingModelV1;

    expect(isFreeBillingModel(model)).toBe(false);
    expect(validateServiceBillingModelV1(model)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("non-negative finite number"),
      ]),
    );
  });

  it("uses the request path instead of the first advertised protocol", () => {
    const request: SerializedHttpRequest = {
      requestId: "req-image",
      method: "POST",
      path: "/v1/images/generations",
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode(JSON.stringify({ model: "gpt-4o", prompt: "cube" })),
    };
    const peer: PeerInfo = {
      peerId: "a".repeat(40) as PeerInfo["peerId"],
      lastSeen: Date.now(),
      providers: ["openai"],
      providerServiceApiProtocols: {
        openai: {
          services: {
            "gpt-4o": ["openai-chat-completions", "openai-images"],
          },
        },
      },
      providerServiceBillingModels: {
        openai: {
          services: {
            "gpt-4o": {
              "openai-images": {
                version: 1,
                components: [{ meter: "output_images", unit: "per_unit", priceUsd: 0.04 }],
              },
            },
          },
        },
      },
    };

    expect(captureBillingContext({
      sellerPeerId: peer.peerId,
      provider: "openai",
      service: "gpt-4o",
      serviceApiProtocol: "openai-images",
      request,
    }).context.serviceApiProtocol).toBe("openai-images");
    expect(captureSellerBillingContext({
      sellerPeerId: "a".repeat(40),
      provider: "openai",
      service: "gpt-4o",
      serviceApiProtocol: "openai-images",
      request,
    }).context.serviceApiProtocol).toBe("openai-images");
  });
});
