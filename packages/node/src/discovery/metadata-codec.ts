import type { DomainVerificationClaim, DomainVerificationMethod, GithubVerificationClaim, PeerMetadata } from "./peer-metadata.js";
import type { PeerOffering } from "../types/capability.js";
import { hexToBytes, bytesToHex } from "../utils/hex.js";
import { toPeerId } from "../types/peer.js";
import type { ServiceApiProtocol } from "../types/service-api.js";
import { WELL_KNOWN_SERVICE_API_PROTOCOLS, isKnownServiceApiProtocol } from "../types/service-api.js";
import type {
  BillingComponentV1,
  BillingMatchKeyV1,
  BillingMeterV1,
  BillingUnitV1,
  ServiceBillingModelV1,
} from "../types/billing.js";
import {
  BILLING_MATCH_KEYS_V1,
  TOKEN_BILLING_METERS_V1,
  UNIT_BILLING_METERS_V1,
} from "../types/billing.js";

const SERVICE_CATEGORIES_METADATA_VERSION = 3;
const SERVICE_API_PROTOCOLS_METADATA_VERSION = 4;
const PUBLIC_ADDRESS_METADATA_VERSION = 5;
const SELLER_CONTRACT_METADATA_VERSION = 8;
const DOMAIN_VERIFICATION_METADATA_VERSION = 9;
const PEER_CAPABILITIES_METADATA_VERSION = 10;
const DOMAIN_VERIFICATION_METHOD_IDS: Record<DomainVerificationMethod, number> = {
  "dns-txt": 0,
  "https-well-known": 1,
};
const DOMAIN_VERIFICATION_METHODS_BY_ID: DomainVerificationMethod[] = ["dns-txt", "https-well-known"];
const SERVICE_BILLING_METADATA_VERSION = 11;
const BILLING_METERS_BY_ID: BillingMeterV1[] = [...TOKEN_BILLING_METERS_V1, ...UNIT_BILLING_METERS_V1];
const BILLING_METER_IDS = new Map<BillingMeterV1, number>(BILLING_METERS_BY_ID.map((meter, index) => [meter, index]));
const BILLING_UNITS_BY_ID: BillingUnitV1[] = ["per_million", "per_unit"];
const BILLING_UNIT_IDS = new Map<BillingUnitV1, number>(BILLING_UNITS_BY_ID.map((unit, index) => [unit, index]));
const BILLING_MATCH_KEYS_BY_ID: BillingMatchKeyV1[] = [...BILLING_MATCH_KEYS_V1];
const BILLING_MATCH_KEY_IDS = new Map<BillingMatchKeyV1, number>(BILLING_MATCH_KEYS_BY_ID.map((key, index) => [key, index]));

/**
 * Encode metadata into binary format:
 * [version:1][peerId:20][regionLen:1][region:N][timestamp:8 BigUint64][providerCount:1]
 * for each provider:
 *   [providerLen:1][provider:N][serviceCount:1][services...]
 *   [defaultInputPrice:4][defaultOutputPrice:4][defaultCachedInputPrice:4]
 *   [servicePricingCount:1][servicePricingEntries...]
 *   [serviceCategoryCount:1][serviceCategoryEntries...] (v3+ only)
 *   [serviceApiProtocolCount:1][serviceApiProtocolEntries...] (v4+ only)
 *   [maxConcurrency:2][currentLoad:2]
 * servicePricingEntry: [serviceLen:1][service:N][inputPrice:4][outputPrice:4][cachedInputPrice:4]
 * serviceCategoryEntry(v3+): [serviceLen:1][service:N][categoryCount:1][categories...]
 * category(v3+): [categoryLen:1][category:N]
 * serviceApiProtocolEntry(v4+): [serviceLen:1][service:N][protocolCount:1][protocols...]
 * protocol(v4+): [protocolLen:1][protocol:N]
 * [displayNameFlag:1][displayNameLen:1][displayName:N] (v3+ only)
 * [publicAddressFlag:1][publicAddressLen:1][publicAddress:N] (v5+ only)
 * [sellerContractFlag:1][sellerContract:20] (v8+ only)
 * [domainVerificationCount:1][domainVerificationEntries...] (v9+ only)
 * domainVerificationEntry(v9+): [domainLen:1][domain:N][methodCount:1][methodIds...]
 * [githubVerificationCount:1][githubVerificationEntries...] (v9+ only)
 * githubVerificationEntry(v9+): [usernameLen:1][username:N][repoLen:1][repo:N] (repoLen 0 = profile repo)
 * [offerings...]
 * [onChainStatsFlag:1][onChainStats:10]
 * [capabilityCount:1][capabilities...] (v10+ only)
 * capability(v10+): [capabilityLen:1][capability:N]
 * [signature:65]
 */
export function encodeMetadata(metadata: PeerMetadata): Uint8Array {
  const bodyBytes = encodeBody(metadata);
  const signatureBytes = hexToBytes(metadata.signature);

  const result = new Uint8Array(bodyBytes.length + signatureBytes.length);
  result.set(bodyBytes, 0);
  result.set(signatureBytes, bodyBytes.length);
  return result;
}

/**
 * Encode metadata without signature, for signing purposes.
 */
export function encodeMetadataForSigning(metadata: PeerMetadata): Uint8Array {
  return encodeBody(metadata);
}

function encodeBody(metadata: PeerMetadata): Uint8Array {
  const parts: Uint8Array[] = [];
  const hasServiceCategoryExtensions = metadata.version >= SERVICE_CATEGORIES_METADATA_VERSION;
  const hasServiceApiProtocolExtensions = metadata.version >= SERVICE_API_PROTOCOLS_METADATA_VERSION;

  // version: 1 byte
  parts.push(new Uint8Array([metadata.version]));

  // peerId: 20 bytes (EVM address)
  parts.push(hexToBytes(metadata.peerId));

  // region: length-prefixed
  const regionBytes = new TextEncoder().encode(metadata.region);
  parts.push(new Uint8Array([regionBytes.length]));
  parts.push(regionBytes);

  // timestamp: 8 bytes BigUint64
  const timestampBuf = new ArrayBuffer(8);
  const timestampView = new DataView(timestampBuf);
  timestampView.setBigUint64(0, BigInt(metadata.timestamp), false);
  parts.push(new Uint8Array(timestampBuf));

  // providerCount: 1 byte
  parts.push(new Uint8Array([metadata.providers.length]));

  // each provider
  for (const p of metadata.providers) {
    const providerNameBytes = new TextEncoder().encode(p.provider);
    parts.push(new Uint8Array([providerNameBytes.length]));
    parts.push(providerNameBytes);

    // serviceCount: 1 byte
    parts.push(new Uint8Array([p.services.length]));

    // each service: length-prefixed
    for (const service of p.services) {
      const serviceBytes = new TextEncoder().encode(service);
      parts.push(new Uint8Array([serviceBytes.length]));
      parts.push(serviceBytes);
    }

    // default input price: 4 bytes (float32)
    const inputPriceBuf = new ArrayBuffer(4);
    new DataView(inputPriceBuf).setFloat32(0, p.defaultPricing.inputUsdPerMillion, false);
    parts.push(new Uint8Array(inputPriceBuf));

    // default output price: 4 bytes (float32)
    const outputPriceBuf = new ArrayBuffer(4);
    new DataView(outputPriceBuf).setFloat32(0, p.defaultPricing.outputUsdPerMillion, false);
    parts.push(new Uint8Array(outputPriceBuf));

    // default cached input price: 4 bytes (float32) (v7+)
    const cachedInputPriceBuf = new ArrayBuffer(4);
    new DataView(cachedInputPriceBuf).setFloat32(0, p.defaultPricing.cachedInputUsdPerMillion ?? 0, false);
    parts.push(new Uint8Array(cachedInputPriceBuf));

    // servicePricing entries
    const servicePricingEntries = Object.entries(p.servicePricing ?? {}).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    parts.push(new Uint8Array([servicePricingEntries.length]));
    for (const [serviceName, pricing] of servicePricingEntries) {
      const serviceNameBytes = new TextEncoder().encode(serviceName);
      parts.push(new Uint8Array([serviceNameBytes.length]));
      parts.push(serviceNameBytes);

      const serviceInputBuf = new ArrayBuffer(4);
      new DataView(serviceInputBuf).setFloat32(0, pricing.inputUsdPerMillion, false);
      parts.push(new Uint8Array(serviceInputBuf));

      const serviceOutputBuf = new ArrayBuffer(4);
      new DataView(serviceOutputBuf).setFloat32(0, pricing.outputUsdPerMillion, false);
      parts.push(new Uint8Array(serviceOutputBuf));

      // service cached input price: 4 bytes (float32) (v7+)
      const serviceCachedInputBuf = new ArrayBuffer(4);
      new DataView(serviceCachedInputBuf).setFloat32(0, pricing.cachedInputUsdPerMillion ?? 0, false);
      parts.push(new Uint8Array(serviceCachedInputBuf));
    }

    if (hasServiceCategoryExtensions) {
      const serviceCategoryEntries = Object.entries(p.serviceCategories ?? {})
        .map(([serviceName, categories]) => {
          const normalizedCategories = Array.from(
            new Set(
              categories
                .map((category) => category.trim().toLowerCase())
                .filter((category) => category.length > 0),
            ),
          ).sort();
          return [serviceName, normalizedCategories] as const;
        })
        .filter(([, categories]) => categories.length > 0)
        .sort(([a], [b]) => a.localeCompare(b));

      parts.push(new Uint8Array([serviceCategoryEntries.length]));
      for (const [serviceName, categories] of serviceCategoryEntries) {
        const serviceNameBytes = new TextEncoder().encode(serviceName);
        parts.push(new Uint8Array([serviceNameBytes.length]));
        parts.push(serviceNameBytes);
        parts.push(new Uint8Array([categories.length]));
        for (const category of categories) {
          const categoryBytes = new TextEncoder().encode(category);
          parts.push(new Uint8Array([categoryBytes.length]));
          parts.push(categoryBytes);
        }
      }
    }

    if (hasServiceApiProtocolExtensions) {
      const serviceApiProtocolEntries = Object.entries(p.serviceApiProtocols ?? {})
        .map(([serviceName, protocols]) => {
          const normalizedProtocols = Array.from(
            new Set(
              protocols
                .map((protocol) => protocol.trim().toLowerCase())
                .filter((protocol): protocol is ServiceApiProtocol => isKnownServiceApiProtocol(protocol)),
            ),
          ).sort();
          return [serviceName, normalizedProtocols] as const;
        })
        .filter(([, protocols]) => protocols.length > 0)
        .sort(([a], [b]) => a.localeCompare(b));

      parts.push(new Uint8Array([serviceApiProtocolEntries.length]));
      for (const [serviceName, protocols] of serviceApiProtocolEntries) {
        const serviceNameBytes = new TextEncoder().encode(serviceName);
        parts.push(new Uint8Array([serviceNameBytes.length]));
        parts.push(serviceNameBytes);
        parts.push(new Uint8Array([protocols.length]));
        for (const protocol of protocols) {
          const protocolBytes = new TextEncoder().encode(protocol);
          parts.push(new Uint8Array([protocolBytes.length]));
          parts.push(protocolBytes);
        }
      }
    }

    if (metadata.version >= SERVICE_BILLING_METADATA_VERSION) {
      encodeServiceBillingModels(parts, p.serviceBillingModels);
    }

    // maxConcurrency: 2 bytes (uint16)
    const maxConcBuf = new ArrayBuffer(2);
    new DataView(maxConcBuf).setUint16(0, p.maxConcurrency, false);
    parts.push(new Uint8Array(maxConcBuf));

    // currentLoad: 2 bytes (uint16)
    const loadBuf = new ArrayBuffer(2);
    new DataView(loadBuf).setUint16(0, p.currentLoad, false);
    parts.push(new Uint8Array(loadBuf));
  }

  if (hasServiceCategoryExtensions) {
    const displayName = metadata.displayName?.trim();
    if (displayName && displayName.length > 0) {
      const displayNameBytes = new TextEncoder().encode(displayName);
      parts.push(new Uint8Array([1]));
      parts.push(new Uint8Array([displayNameBytes.length]));
      parts.push(displayNameBytes);
    } else {
      parts.push(new Uint8Array([0]));
    }
  }

  if (metadata.version >= PUBLIC_ADDRESS_METADATA_VERSION) {
    const publicAddress = metadata.publicAddress?.trim();
    if (publicAddress && publicAddress.length > 0) {
      const publicAddressBytes = new TextEncoder().encode(publicAddress);
      parts.push(new Uint8Array([1]));
      parts.push(new Uint8Array([publicAddressBytes.length]));
      parts.push(publicAddressBytes);
    } else {
      parts.push(new Uint8Array([0]));
    }
  }

  // sellerContract (v8+) — flag + [sellerContract:20]
  // Buyers verify the peer→contract binding via `sellerContract.isOperator(peerAddress)`.
  if (metadata.version >= SELLER_CONTRACT_METADATA_VERSION) {
    const sc = metadata.sellerContract;
    if (sc) {
      parts.push(new Uint8Array([1]));
      parts.push(hexToBytes(sc)); // 20 bytes
    } else {
      parts.push(new Uint8Array([0]));
    }
  }

  if (metadata.version >= DOMAIN_VERIFICATION_METADATA_VERSION) {
    const claims = (metadata.verifications?.domains ?? [])
      .map((claim) => ({
        domain: claim.domain.trim().toLowerCase(),
        methods: claim.methods
          ? Array.from(new Set(claim.methods.map((method) => method.trim() as DomainVerificationMethod)))
          : undefined,
      }))
      .filter((claim) => claim.domain.length > 0)
      // Code-unit sort, not localeCompare: buyers verify signatures by
      // re-encoding decoded metadata, so claim order must not depend on the
      // verifier's locale.
      .sort((a, b) => (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0));
    if (claims.length > 255) {
      throw new Error(`Too many domain verification claims (${claims.length})`);
    }
    parts.push(new Uint8Array([claims.length]));
    for (const claim of claims) {
      const domainBytes = new TextEncoder().encode(claim.domain);
      if (domainBytes.length > 255) {
        throw new Error(`Domain verification claim too long (${domainBytes.length} bytes)`);
      }
      parts.push(new Uint8Array([domainBytes.length]));
      parts.push(domainBytes);
      const methods = claim.methods
        ? claim.methods
          .slice()
          .sort((a, b) => DOMAIN_VERIFICATION_METHOD_IDS[a] - DOMAIN_VERIFICATION_METHOD_IDS[b])
        : [];
      parts.push(new Uint8Array([methods.length]));
      for (const method of methods) {
        const methodId = DOMAIN_VERIFICATION_METHOD_IDS[method];
        if (methodId === undefined) {
          throw new Error(`Unsupported domain verification method "${method}"`);
        }
        parts.push(new Uint8Array([methodId]));
      }
    }

    const githubClaims = (metadata.verifications?.github ?? [])
      .map((claim) => ({
        username: claim.username.trim().toLowerCase(),
        repository: claim.repository ? claim.repository.trim().toLowerCase() : "",
      }))
      .filter((claim) => claim.username.length > 0)
      // Code-unit sort for the same locale-independence reason as domains.
      .sort((a, b) => (a.username < b.username ? -1 : a.username > b.username ? 1
        : a.repository < b.repository ? -1 : a.repository > b.repository ? 1 : 0));
    if (githubClaims.length > 255) {
      throw new Error(`Too many GitHub verification claims (${githubClaims.length})`);
    }
    parts.push(new Uint8Array([githubClaims.length]));
    for (const claim of githubClaims) {
      const usernameBytes = new TextEncoder().encode(claim.username);
      const repositoryBytes = new TextEncoder().encode(claim.repository);
      if (usernameBytes.length > 255 || repositoryBytes.length > 255) {
        throw new Error("GitHub verification claim too long");
      }
      parts.push(new Uint8Array([usernameBytes.length]));
      parts.push(usernameBytes);
      parts.push(new Uint8Array([repositoryBytes.length]));
      parts.push(repositoryBytes);
    }
  }

  // offerings
  const offerings = metadata.offerings ?? [];
  const offeringCountBuf = new ArrayBuffer(2);
  new DataView(offeringCountBuf).setUint16(0, offerings.length, false);
  parts.push(new Uint8Array(offeringCountBuf));

  const PRICING_UNIT_MAP: Record<string, number> = { token: 0, request: 1, minute: 2, task: 3 };

  for (const o of offerings) {
    const capBytes = new TextEncoder().encode(o.capability);
    parts.push(new Uint8Array([capBytes.length]));
    parts.push(capBytes);

    const nameBytes = new TextEncoder().encode(o.name);
    parts.push(new Uint8Array([nameBytes.length]));
    parts.push(nameBytes);

    const descBytes = new TextEncoder().encode(o.description);
    const descLenBuf = new ArrayBuffer(2);
    new DataView(descLenBuf).setUint16(0, descBytes.length, false);
    parts.push(new Uint8Array(descLenBuf));
    parts.push(descBytes);

    parts.push(new Uint8Array([PRICING_UNIT_MAP[o.pricing.unit] ?? 0]));

    const priceBuf = new ArrayBuffer(4);
    new DataView(priceBuf).setFloat32(0, o.pricing.pricePerUnit, false);
    parts.push(new Uint8Array(priceBuf));

    const offeringServices = o.services ?? [];
    parts.push(new Uint8Array([offeringServices.length]));
    for (const service of offeringServices) {
      const serviceBytes = new TextEncoder().encode(service);
      parts.push(new Uint8Array([serviceBytes.length]));
      parts.push(serviceBytes);
    }
  }

  // On-chain stats: 1 flag byte + 10 data bytes (1 reserved + 4 channelCount + 4 ghostCount + 1 reserved)
  if (metadata.onChainChannelCount !== undefined) {
    parts.push(new Uint8Array([1])); // flag: present
    const repBuf = new ArrayBuffer(10);
    const repView = new DataView(repBuf);
    repView.setUint8(0, Math.min(255, metadata.onChainChannelCount)); // legacy reputation byte — channelCount capped to u8
    repView.setUint32(1, metadata.onChainChannelCount, false);
    repView.setUint32(5, metadata.onChainGhostCount ?? 0, false);
    repView.setUint8(9, 0); // reserved
    parts.push(new Uint8Array(repBuf));
  } else {
    parts.push(new Uint8Array([0])); // flag: absent
  }

  if (metadata.version >= PEER_CAPABILITIES_METADATA_VERSION) {
    const capabilities = Array.from(
      new Set(
        (metadata.capabilities ?? [])
          .map((capability) => capability.trim().toLowerCase())
          .filter((capability) => capability.length > 0),
      ),
    ).sort();
    parts.push(new Uint8Array([capabilities.length]));
    for (const capability of capabilities) {
      const capabilityBytes = new TextEncoder().encode(capability);
      parts.push(new Uint8Array([capabilityBytes.length]));
      parts.push(capabilityBytes);
    }
  }

  // Combine all parts
  const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function encodeServiceBillingModels(
  parts: Uint8Array[],
  serviceBillingModels: PeerMetadata["providers"][number]["serviceBillingModels"],
): void {
  const entries: Array<[string, ServiceApiProtocol, ServiceBillingModelV1]> = [];
  for (const [serviceName, protocolModels] of Object.entries(serviceBillingModels ?? {})) {
    for (const protocol of WELL_KNOWN_SERVICE_API_PROTOCOLS) {
      const model = protocolModels?.[protocol];
      if (model) entries.push([serviceName, protocol, model]);
    }
  }
  entries.sort(([serviceA, protocolA], [serviceB, protocolB]) =>
    serviceA === serviceB
      ? WELL_KNOWN_SERVICE_API_PROTOCOLS.indexOf(protocolA) - WELL_KNOWN_SERVICE_API_PROTOCOLS.indexOf(protocolB)
      : serviceA.localeCompare(serviceB),
  );
  parts.push(new Uint8Array([entries.length]));
  for (const [serviceName, protocol, model] of entries) {
    pushUtf8(parts, serviceName);
    parts.push(new Uint8Array([WELL_KNOWN_SERVICE_API_PROTOCOLS.indexOf(protocol)]));
    parts.push(new Uint8Array([model.version]));
    parts.push(new Uint8Array([model.components.length]));
    for (const component of model.components) {
      parts.push(new Uint8Array([BILLING_METER_IDS.get(component.meter) ?? 255]));
      parts.push(new Uint8Array([BILLING_UNIT_IDS.get(component.unit) ?? 255]));
      const priceBuf = new ArrayBuffer(4);
      new DataView(priceBuf).setFloat32(0, component.priceUsd, false);
      parts.push(new Uint8Array(priceBuf));
      const matchEntries = Object.entries(component.match ?? {})
        .filter((entry): entry is [BillingMatchKeyV1, string] => BILLING_MATCH_KEY_IDS.has(entry[0] as BillingMatchKeyV1))
        .sort(([a], [b]) => (BILLING_MATCH_KEY_IDS.get(a) ?? 0) - (BILLING_MATCH_KEY_IDS.get(b) ?? 0));
      parts.push(new Uint8Array([matchEntries.length]));
      for (const [key, value] of matchEntries) {
        parts.push(new Uint8Array([BILLING_MATCH_KEY_IDS.get(key) ?? 255]));
        pushUtf8(parts, value);
      }
    }
  }
}

function pushUtf8(parts: Uint8Array[], value: string): void {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length > 255) {
    throw new Error(`Metadata string too long (${bytes.length} bytes)`);
  }
  parts.push(new Uint8Array([bytes.length]));
  parts.push(bytes);
}

function decodeServiceBillingModels(
  data: Uint8Array,
  getOffset: () => number,
  setOffset: (offset: number) => void,
  checkBounds: (offset: number, needed: number, total: number) => void,
): PeerMetadata["providers"][number]["serviceBillingModels"] | undefined {
  let offset = getOffset();
  checkBounds(offset, 1, data.length);
  const entryCount = data[offset]!;
  offset += 1;
  const serviceBillingModels: NonNullable<PeerMetadata["providers"][number]["serviceBillingModels"]> = {};
  for (let i = 0; i < entryCount; i += 1) {
    const [serviceName, serviceOffset] = readUtf8(data, offset, checkBounds);
    offset = serviceOffset;
    checkBounds(offset, 1, data.length);
    const protocol = WELL_KNOWN_SERVICE_API_PROTOCOLS[data[offset]!];
    offset += 1;
    if (!protocol) {
      throw new Error("Unsupported service billing protocol id");
    }
    checkBounds(offset, 2, data.length);
    const version = data[offset]!;
    offset += 1;
    if (version !== 1) {
      throw new Error(`Unsupported service billing model version ${version}`);
    }
    const componentCount = data[offset]!;
    offset += 1;
    const components: BillingComponentV1[] = [];
    for (let j = 0; j < componentCount; j += 1) {
      checkBounds(offset, 7, data.length);
      const meter = BILLING_METERS_BY_ID[data[offset]!];
      offset += 1;
      const unit = BILLING_UNITS_BY_ID[data[offset]!];
      offset += 1;
      if (!meter || !unit) {
        throw new Error("Unsupported service billing component meter or unit");
      }
      const priceUsd = new DataView(data.buffer, data.byteOffset + offset, 4).getFloat32(0, false);
      offset += 4;
      const matchCount = data[offset]!;
      offset += 1;
      const match: Partial<Record<BillingMatchKeyV1, string>> = {};
      for (let k = 0; k < matchCount; k += 1) {
        checkBounds(offset, 1, data.length);
        const key = BILLING_MATCH_KEYS_BY_ID[data[offset]!];
        offset += 1;
        if (!key) {
          throw new Error("Unsupported service billing match key");
        }
        const [value, valueOffset] = readUtf8(data, offset, checkBounds);
        offset = valueOffset;
        match[key] = value;
      }
      const base = { meter, unit, priceUsd, ...(Object.keys(match).length > 0 ? { match } : {}) };
      components.push(base as BillingComponentV1);
    }
    serviceBillingModels[serviceName] = {
      ...(serviceBillingModels[serviceName] ?? {}),
      [protocol]: { version: 1, components },
    };
  }
  setOffset(offset);
  return Object.keys(serviceBillingModels).length > 0 ? serviceBillingModels : undefined;
}

function readUtf8(
  data: Uint8Array,
  offset: number,
  checkBounds: (offset: number, needed: number, total: number) => void,
): [string, number] {
  checkBounds(offset, 1, data.length);
  const length = data[offset]!;
  const valueOffset = offset + 1;
  checkBounds(valueOffset, length, data.length);
  return [new TextDecoder().decode(data.slice(valueOffset, valueOffset + length)), valueOffset + length];
}

/**
 * Decode binary metadata back into PeerMetadata.
 */
export function decodeMetadata(data: Uint8Array): PeerMetadata {
  function checkBounds(offset: number, needed: number, total: number): void {
    if (offset + needed > total) throw new Error('Truncated metadata buffer');
  }

  let offset = 0;

  // version: 1 byte
  checkBounds(offset, 1, data.length);
  const version = data[offset]!;
  if (version < 7) {
    throw new Error(`Unsupported metadata version ${version}: pre-v7 format is no longer supported`);
  }
  const hasServiceCategoryExtensions = version >= SERVICE_CATEGORIES_METADATA_VERSION;
  const hasServiceApiProtocolExtensions = version >= SERVICE_API_PROTOCOLS_METADATA_VERSION;
  const hasPublicAddressExtension = version >= PUBLIC_ADDRESS_METADATA_VERSION;
  offset += 1;

  // peerId: 20 bytes (EVM address)
  checkBounds(offset, 20, data.length);
  const peerIdBytes = data.slice(offset, offset + 20);
  const peerId = bytesToHex(peerIdBytes);
  offset += 20;

  // region: length-prefixed
  checkBounds(offset, 1, data.length);
  const regionLen = data[offset]!;
  offset += 1;
  checkBounds(offset, regionLen, data.length);
  const region = new TextDecoder().decode(data.slice(offset, offset + regionLen));
  offset += regionLen;

  // timestamp: 8 bytes BigUint64
  checkBounds(offset, 8, data.length);
  const timestampView = new DataView(data.buffer, data.byteOffset + offset, 8);
  const timestamp = Number(timestampView.getBigUint64(0, false));
  offset += 8;

  // providerCount: 1 byte
  checkBounds(offset, 1, data.length);
  const providerCount = data[offset]!;
  offset += 1;

  const providers = [];
  for (let i = 0; i < providerCount; i++) {
    // provider name: length-prefixed
    checkBounds(offset, 1, data.length);
    const providerLen = data[offset]!;
    offset += 1;
    checkBounds(offset, providerLen, data.length);
    const provider = new TextDecoder().decode(data.slice(offset, offset + providerLen));
    offset += providerLen;

    // serviceCount: 1 byte
    checkBounds(offset, 1, data.length);
    const serviceCount = data[offset]!;
    offset += 1;

    const services: string[] = [];
    for (let j = 0; j < serviceCount; j++) {
      checkBounds(offset, 1, data.length);
      const serviceLen = data[offset]!;
      offset += 1;
      checkBounds(offset, serviceLen, data.length);
      const service = new TextDecoder().decode(data.slice(offset, offset + serviceLen));
      offset += serviceLen;
      services.push(service);
    }

    // default input price: 4 bytes float32
    checkBounds(offset, 4, data.length);
    const inputPriceView = new DataView(data.buffer, data.byteOffset + offset, 4);
    const defaultInputUsdPerMillion = inputPriceView.getFloat32(0, false);
    offset += 4;

    // default output price: 4 bytes float32
    checkBounds(offset, 4, data.length);
    const outputPriceView = new DataView(data.buffer, data.byteOffset + offset, 4);
    const defaultOutputUsdPerMillion = outputPriceView.getFloat32(0, false);
    offset += 4;

    // default cached input price: 4 bytes float32 (v7+)
    checkBounds(offset, 4, data.length);
    const cachedInputPriceView = new DataView(data.buffer, data.byteOffset + offset, 4);
    const defaultCachedInputUsdPerMillion = cachedInputPriceView.getFloat32(0, false);
    offset += 4;

    // servicePricing entries
    checkBounds(offset, 1, data.length);
    const servicePricingCount = data[offset]!;
    offset += 1;

    const servicePricing: Record<string, { inputUsdPerMillion: number; outputUsdPerMillion: number; cachedInputUsdPerMillion?: number }> = {};
    for (let j = 0; j < servicePricingCount; j++) {
      checkBounds(offset, 1, data.length);
      const pricedServiceLen = data[offset]!;
      offset += 1;
      checkBounds(offset, pricedServiceLen, data.length);
      const pricedServiceName = new TextDecoder().decode(data.slice(offset, offset + pricedServiceLen));
      offset += pricedServiceLen;

      checkBounds(offset, 4, data.length);
      const pricedInputView = new DataView(data.buffer, data.byteOffset + offset, 4);
      const inputUsdPerMillion = pricedInputView.getFloat32(0, false);
      offset += 4;

      checkBounds(offset, 4, data.length);
      const pricedOutputView = new DataView(data.buffer, data.byteOffset + offset, 4);
      const outputUsdPerMillion = pricedOutputView.getFloat32(0, false);
      offset += 4;

      // service cached input price: 4 bytes float32 (v7+)
      checkBounds(offset, 4, data.length);
      const pricedCachedInputView = new DataView(data.buffer, data.byteOffset + offset, 4);
      const cachedInputUsdPerMillion = pricedCachedInputView.getFloat32(0, false);
      offset += 4;

      servicePricing[pricedServiceName] = {
        inputUsdPerMillion,
        outputUsdPerMillion,
        ...(cachedInputUsdPerMillion !== 0 ? { cachedInputUsdPerMillion } : {}),
      };
    }

    let serviceCategories: Record<string, string[]> | undefined;
    if (hasServiceCategoryExtensions) {
      checkBounds(offset, 1, data.length);
      const serviceCategoryCount = data[offset]!;
      offset += 1;
      if (serviceCategoryCount > 0) {
        serviceCategories = {};
        for (let j = 0; j < serviceCategoryCount; j++) {
          checkBounds(offset, 1, data.length);
          const categorizedServiceLen = data[offset]!;
          offset += 1;
          checkBounds(offset, categorizedServiceLen, data.length);
          const categorizedServiceName = new TextDecoder().decode(data.slice(offset, offset + categorizedServiceLen));
          offset += categorizedServiceLen;

          checkBounds(offset, 1, data.length);
          const categoryCount = data[offset]!;
          offset += 1;
          const categories: string[] = [];
          for (let k = 0; k < categoryCount; k++) {
            checkBounds(offset, 1, data.length);
            const categoryLen = data[offset]!;
            offset += 1;
            checkBounds(offset, categoryLen, data.length);
            const category = new TextDecoder().decode(data.slice(offset, offset + categoryLen));
            offset += categoryLen;
            categories.push(category);
          }
          serviceCategories[categorizedServiceName] = categories;
        }
      }
    }

    let serviceApiProtocols: Record<string, ServiceApiProtocol[]> | undefined;
    if (hasServiceApiProtocolExtensions) {
      checkBounds(offset, 1, data.length);
      const serviceApiProtocolCount = data[offset]!;
      offset += 1;
      if (serviceApiProtocolCount > 0) {
        serviceApiProtocols = {};
        for (let j = 0; j < serviceApiProtocolCount; j++) {
          checkBounds(offset, 1, data.length);
          const protocolServiceLen = data[offset]!;
          offset += 1;
          checkBounds(offset, protocolServiceLen, data.length);
          const protocolServiceName = new TextDecoder().decode(data.slice(offset, offset + protocolServiceLen));
          offset += protocolServiceLen;

          checkBounds(offset, 1, data.length);
          const protocolCount = data[offset]!;
          offset += 1;
          const protocols: ServiceApiProtocol[] = [];
          for (let k = 0; k < protocolCount; k++) {
            checkBounds(offset, 1, data.length);
            const protocolLen = data[offset]!;
            offset += 1;
            checkBounds(offset, protocolLen, data.length);
            const protocol = new TextDecoder().decode(data.slice(offset, offset + protocolLen));
            offset += protocolLen;
            protocols.push(protocol as ServiceApiProtocol);
          }
          serviceApiProtocols[protocolServiceName] = protocols;
        }
      }
    }

    const serviceBillingModels = version >= SERVICE_BILLING_METADATA_VERSION
      ? decodeServiceBillingModels(data, () => offset, (next) => { offset = next; }, checkBounds)
      : undefined;

    // maxConcurrency: 2 bytes uint16
    checkBounds(offset, 2, data.length);
    const maxConcView = new DataView(data.buffer, data.byteOffset + offset, 2);
    const maxConcurrency = maxConcView.getUint16(0, false);
    offset += 2;

    // currentLoad: 2 bytes uint16
    checkBounds(offset, 2, data.length);
    const loadView = new DataView(data.buffer, data.byteOffset + offset, 2);
    const currentLoad = loadView.getUint16(0, false);
    offset += 2;

    providers.push({
      provider,
      services,
      defaultPricing: {
        inputUsdPerMillion: defaultInputUsdPerMillion,
        outputUsdPerMillion: defaultOutputUsdPerMillion,
        ...(defaultCachedInputUsdPerMillion !== 0 ? { cachedInputUsdPerMillion: defaultCachedInputUsdPerMillion } : {}),
      },
      ...(servicePricingCount > 0 ? { servicePricing } : {}),
      ...(serviceCategories && Object.keys(serviceCategories).length > 0 ? { serviceCategories } : {}),
      ...(serviceApiProtocols && Object.keys(serviceApiProtocols).length > 0 ? { serviceApiProtocols } : {}),
      ...(serviceBillingModels && Object.keys(serviceBillingModels).length > 0 ? { serviceBillingModels } : {}),
      maxConcurrency,
      currentLoad,
    });
  }

  let displayName: string | undefined;
  if (hasServiceCategoryExtensions) {
    checkBounds(offset, 1, data.length - 65);
    const displayNameFlag = data[offset]!;
    offset += 1;
    if (displayNameFlag === 1) {
      checkBounds(offset, 1, data.length - 65);
      const displayNameLen = data[offset]!;
      offset += 1;
      checkBounds(offset, displayNameLen, data.length - 65);
      displayName = new TextDecoder().decode(data.slice(offset, offset + displayNameLen));
      offset += displayNameLen;
    }
  }

  let publicAddress: string | undefined;
  if (hasPublicAddressExtension) {
    checkBounds(offset, 1, data.length - 65);
    const publicAddressFlag = data[offset]!;
    offset += 1;
    if (publicAddressFlag === 1) {
      checkBounds(offset, 1, data.length - 65);
      const publicAddressLen = data[offset]!;
      offset += 1;
      checkBounds(offset, publicAddressLen, data.length - 65);
      publicAddress = new TextDecoder().decode(data.slice(offset, offset + publicAddressLen));
      offset += publicAddressLen;
    }
  }

  let sellerContract: string | undefined;
  if (version >= SELLER_CONTRACT_METADATA_VERSION) {
    checkBounds(offset, 1, data.length - 65);
    const sellerContractFlag = data[offset]!;
    offset += 1;
    if (sellerContractFlag === 1) {
      checkBounds(offset, 20, data.length - 65);
      sellerContract = bytesToHex(data.slice(offset, offset + 20));
      offset += 20;
    }
  }

  let domainVerifications: DomainVerificationClaim[] | undefined;
  if (version >= DOMAIN_VERIFICATION_METADATA_VERSION) {
    checkBounds(offset, 1, data.length - 65);
    const domainVerificationCount = data[offset]!;
    offset += 1;
    if (domainVerificationCount > 0) {
      domainVerifications = [];
      for (let i = 0; i < domainVerificationCount; i += 1) {
        checkBounds(offset, 1, data.length - 65);
        const domainLen = data[offset]!;
        offset += 1;
        checkBounds(offset, domainLen, data.length - 65);
        const domain = new TextDecoder().decode(data.slice(offset, offset + domainLen));
        offset += domainLen;

        checkBounds(offset, 1, data.length - 65);
        const methodCount = data[offset]!;
        offset += 1;
        const methods: DomainVerificationMethod[] = [];
        for (let j = 0; j < methodCount; j += 1) {
          checkBounds(offset, 1, data.length - 65);
          const method = DOMAIN_VERIFICATION_METHODS_BY_ID[data[offset]!];
          offset += 1;
          if (method === undefined) {
            throw new Error("Unsupported domain verification method id");
          }
          methods.push(method);
        }
        domainVerifications.push({
          domain,
          ...(methods.length > 0 ? { methods } : {}),
        });
      }
    }
  }

  let githubVerifications: GithubVerificationClaim[] | undefined;
  if (version >= DOMAIN_VERIFICATION_METADATA_VERSION) {
    checkBounds(offset, 1, data.length - 65);
    const githubVerificationCount = data[offset]!;
    offset += 1;
    if (githubVerificationCount > 0) {
      githubVerifications = [];
      for (let i = 0; i < githubVerificationCount; i += 1) {
        checkBounds(offset, 1, data.length - 65);
        const usernameLen = data[offset]!;
        offset += 1;
        checkBounds(offset, usernameLen, data.length - 65);
        const username = new TextDecoder().decode(data.slice(offset, offset + usernameLen));
        offset += usernameLen;

        checkBounds(offset, 1, data.length - 65);
        const repositoryLen = data[offset]!;
        offset += 1;
        checkBounds(offset, repositoryLen, data.length - 65);
        const repository = new TextDecoder().decode(data.slice(offset, offset + repositoryLen));
        offset += repositoryLen;

        githubVerifications.push({
          username,
          ...(repository.length > 0 ? { repository } : {}),
        });
      }
    }
  }

  // offerings
  const PRICING_UNIT_REVERSE: Array<'token' | 'request' | 'minute' | 'task'> = ['token', 'request', 'minute', 'task'];
  let offerings: PeerOffering[] | undefined;

  const remainingBeforeSignature = data.length - offset - 65;
  if (remainingBeforeSignature >= 2) {
    offerings = [];
    checkBounds(offset, 2, data.length - 65);
    const offeringCount = new DataView(data.buffer, data.byteOffset + offset, 2).getUint16(0, false);
    offset += 2;

    for (let i = 0; i < offeringCount; i++) {
      checkBounds(offset, 1, data.length - 65);
      const capLen = data[offset]!; offset += 1;
      checkBounds(offset, capLen, data.length - 65);
      const capability = new TextDecoder().decode(data.slice(offset, offset + capLen)); offset += capLen;

      checkBounds(offset, 1, data.length - 65);
      const nameLen = data[offset]!; offset += 1;
      checkBounds(offset, nameLen, data.length - 65);
      const name = new TextDecoder().decode(data.slice(offset, offset + nameLen)); offset += nameLen;

      checkBounds(offset, 2, data.length - 65);
      const descLen = new DataView(data.buffer, data.byteOffset + offset, 2).getUint16(0, false); offset += 2;
      checkBounds(offset, descLen, data.length - 65);
      const description = new TextDecoder().decode(data.slice(offset, offset + descLen)); offset += descLen;

      checkBounds(offset, 1, data.length - 65);
      const unit = PRICING_UNIT_REVERSE[data[offset]!] ?? 'token'; offset += 1;

      checkBounds(offset, 4, data.length - 65);
      const pricePerUnit = new DataView(data.buffer, data.byteOffset + offset, 4).getFloat32(0, false); offset += 4;

      checkBounds(offset, 1, data.length - 65);
      const offeringServiceCount = data[offset]!; offset += 1;
      const offeringServices: string[] = [];
      for (let j = 0; j < offeringServiceCount; j++) {
        checkBounds(offset, 1, data.length - 65);
        const serviceLen = data[offset]!; offset += 1;
        checkBounds(offset, serviceLen, data.length - 65);
        offeringServices.push(new TextDecoder().decode(data.slice(offset, offset + serviceLen))); offset += serviceLen;
      }

      offerings.push({
        capability: capability as PeerOffering['capability'],
        name, description,
        services: offeringServices.length > 0 ? offeringServices : undefined,
        pricing: { unit, pricePerUnit, currency: 'USD' },
      });
    }
  }

  // Optional on-chain stats (flag + 10 bytes)
  let onChainChannelCount: number | undefined;
  let onChainGhostCount: number | undefined;
  const remainingBeforeRepSig = data.length - offset - 65;
  if (remainingBeforeRepSig >= 1) {
    const repFlag = data[offset]!;
    offset += 1;
    if (repFlag === 1) {
      checkBounds(offset, 10, data.length - 65);
      const repView = new DataView(data.buffer, data.byteOffset + offset, 10);
      // byte 0 is legacy reputation (ignored — use channelCount directly)
      onChainChannelCount = repView.getUint32(1, false);
      onChainGhostCount = repView.getUint32(5, false);
      // byte 9 is reserved
      offset += 10;
    }
  }

  let capabilities: string[] | undefined;
  if (version >= PEER_CAPABILITIES_METADATA_VERSION) {
    checkBounds(offset, 1, data.length - 65);
    const capabilityCount = data[offset]!;
    offset += 1;
    if (capabilityCount > 0) {
      capabilities = [];
      for (let i = 0; i < capabilityCount; i++) {
        checkBounds(offset, 1, data.length - 65);
        const capabilityLen = data[offset]!;
        offset += 1;
        checkBounds(offset, capabilityLen, data.length - 65);
        const capability = new TextDecoder().decode(data.slice(offset, offset + capabilityLen));
        offset += capabilityLen;
        capabilities.push(capability);
      }
    }
  }

  // signature: 65 bytes (secp256k1 r+s+v)
  checkBounds(offset, 65, data.length);
  const signatureBytes = data.slice(offset, offset + 65);
  const signature = bytesToHex(signatureBytes);

  const verifications = {
    ...(domainVerifications && domainVerifications.length > 0 ? { domains: domainVerifications } : {}),
    ...(githubVerifications && githubVerifications.length > 0 ? { github: githubVerifications } : {}),
  };

  return {
    peerId: toPeerId(peerId),
    version,
    ...(displayName ? { displayName } : {}),
    ...(publicAddress ? { publicAddress } : {}),
    providers,
    ...(offerings && offerings.length > 0 ? { offerings } : {}),
    ...(onChainChannelCount !== undefined ? { onChainChannelCount } : {}),
    ...(onChainGhostCount !== undefined ? { onChainGhostCount } : {}),
    ...(capabilities && capabilities.length > 0 ? { capabilities } : {}),
    ...(sellerContract ? { sellerContract } : {}),
    ...(Object.keys(verifications).length > 0 ? { verifications } : {}),
    region,
    timestamp,
    signature,
  };
}
