import type { ServicePricing } from "../payments/pricing.js";
import type { ServiceBillingModelV1 } from "../types/billing.js";
import type { ServiceApiProtocol } from "../types/service-api.js";
import { isFreeBillingModel } from "./evaluator.js";

export type BillingMode =
  | { kind: "token"; pricing: ServicePricing; unitModel?: ServiceBillingModelV1 }
  | { kind: "unit"; model: ServiceBillingModelV1 }
  | { kind: "free" }
  | { kind: "unsupported"; reason: string };

export function resolveBillingMode(args: {
  serviceApiProtocol: ServiceApiProtocol;
  tokenPricing?: ServicePricing;
  unitModel?: ServiceBillingModelV1;
}): BillingMode {
  if (args.tokenPricing) {
    return {
      kind: "token",
      pricing: args.tokenPricing,
      ...(args.unitModel && !isFreeBillingModel(args.unitModel) ? { unitModel: args.unitModel } : {}),
    };
  }
  if (args.unitModel && !isFreeBillingModel(args.unitModel)) {
    return { kind: "unit", model: args.unitModel };
  }
  if (args.unitModel && isFreeBillingModel(args.unitModel)) {
    return { kind: "free" };
  }
  return { kind: "unsupported", reason: "missing-pricing" };
}
