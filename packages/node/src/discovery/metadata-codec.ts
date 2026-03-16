import type { PeerMetadata, ServiceAnnouncement, ProviderAnnouncement } from "./peer-metadata.js";
import type { PeerOffering } from "../types/capability.js";
import { hexToBytes, bytesToHex } from "../utils/hex.js";
import { toPeerId } from "../types/peer.js";
import type { ServiceApiProtocol } from "../types/service-api.js";
import { isKnownServiceApiProtocol } from "../types/service-api.js";

const SERVICE_CATEGORIES_METADATA_VERSION = 3;
const SERVICE_API_PROTOCOLS_METADATA_VERSION = 4;
const PUBLIC_ADDRESS_METADATA_VERSION = 5;
const SERVICE_CENTRIC_METADATA_VERSION = 6;

/**
 * Encode metadata into binary format.
 *
 * v6 format (service-centric):
 * [version:1][peerId:32][regionLen:1][region:N][timestamp:8 BigUint64]
 * [serviceCount:1] then per-service:
 *   [nameLen:1][name:N][inputPrice:4][outputPrice:4]
 *   [protocolCount:1][protocols...]
 *   [categoryCount:1][categories...]
 * [maxConcurrency:2][currentLoad:2]
 * [displayNameFlag:1][displayNameLen:1][displayName:N]
 * [publicAddressFlag:1][publicAddressLen:1][publicAddress:N]
 * [offeringCount:2][offerings...]
 * [evmFlag:1][evmAddress:20]
 * [repFlag:1][reputation:10]
 * [signature:64]
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
  if (metadata.version >= SERVICE_CENTRIC_METADATA_VERSION) {
    return encodeBodyV6(metadata);
  }
  return encodeBodyLegacy(metadata);
}

/**
 * v6+ service-centric encoding.
 */
function encodeBodyV6(metadata: PeerMetadata): Uint8Array {
  const parts: Uint8Array[] = [];

  // version: 1 byte
  parts.push(new Uint8Array([metadata.version]));

  // peerId: 32 bytes
  parts.push(hexToBytes(metadata.peerId));

  // region: length-prefixed
  const regionBytes = new TextEncoder().encode(metadata.region);
  parts.push(new Uint8Array([regionBytes.length]));
  parts.push(regionBytes);

  // timestamp: 8 bytes BigUint64
  const timestampBuf = new ArrayBuffer(8);
  new DataView(timestampBuf).setBigUint64(0, BigInt(metadata.timestamp), false);
  parts.push(new Uint8Array(timestampBuf));

  // serviceCount: 1 byte
  const services = metadata.services ?? [];
  parts.push(new Uint8Array([services.length]));

  // each service
  for (const s of services) {
    const nameBytes = new TextEncoder().encode(s.name);
    parts.push(new Uint8Array([nameBytes.length]));
    parts.push(nameBytes);

    // input price: 4 bytes (float32)
    const inputPriceBuf = new ArrayBuffer(4);
    new DataView(inputPriceBuf).setFloat32(0, s.pricing.inputUsdPerMillion, false);
    parts.push(new Uint8Array(inputPriceBuf));

    // output price: 4 bytes (float32)
    const outputPriceBuf = new ArrayBuffer(4);
    new DataView(outputPriceBuf).setFloat32(0, s.pricing.outputUsdPerMillion, false);
    parts.push(new Uint8Array(outputPriceBuf));

    // protocols
    const protocols = (s.protocols ?? [])
      .map((p) => p.trim().toLowerCase())
      .filter((p): p is ServiceApiProtocol => isKnownServiceApiProtocol(p));
    const dedupedProtocols = Array.from(new Set(protocols)).sort();
    parts.push(new Uint8Array([dedupedProtocols.length]));
    for (const protocol of dedupedProtocols) {
      const protocolBytes = new TextEncoder().encode(protocol);
      parts.push(new Uint8Array([protocolBytes.length]));
      parts.push(protocolBytes);
    }

    // categories
    const categories = Array.from(
      new Set(
        (s.categories ?? [])
          .map((c) => c.trim().toLowerCase())
          .filter((c) => c.length > 0),
      ),
    ).sort();
    parts.push(new Uint8Array([categories.length]));
    for (const category of categories) {
      const categoryBytes = new TextEncoder().encode(category);
      parts.push(new Uint8Array([categoryBytes.length]));
      parts.push(categoryBytes);
    }
  }

  // peer-level maxConcurrency: 2 bytes (uint16)
  const maxConcBuf = new ArrayBuffer(2);
  new DataView(maxConcBuf).setUint16(0, metadata.maxConcurrency, false);
  parts.push(new Uint8Array(maxConcBuf));

  // peer-level currentLoad: 2 bytes (uint16)
  const loadBuf = new ArrayBuffer(2);
  new DataView(loadBuf).setUint16(0, metadata.currentLoad, false);
  parts.push(new Uint8Array(loadBuf));

  // displayName
  const displayName = metadata.displayName?.trim();
  if (displayName && displayName.length > 0) {
    const displayNameBytes = new TextEncoder().encode(displayName);
    parts.push(new Uint8Array([1]));
    parts.push(new Uint8Array([displayNameBytes.length]));
    parts.push(displayNameBytes);
  } else {
    parts.push(new Uint8Array([0]));
  }

  // publicAddress
  const publicAddress = metadata.publicAddress?.trim();
  if (publicAddress && publicAddress.length > 0) {
    const publicAddressBytes = new TextEncoder().encode(publicAddress);
    parts.push(new Uint8Array([1]));
    parts.push(new Uint8Array([publicAddressBytes.length]));
    parts.push(publicAddressBytes);
  } else {
    parts.push(new Uint8Array([0]));
  }

  // offerings
  encodeOfferings(parts, metadata.offerings ?? []);

  // EVM address
  encodeEvmAddress(parts, metadata.evmAddress);

  // On-chain reputation
  encodeOnChainReputation(parts, metadata);

  // Combine all parts
  return combineParts(parts);
}

/**
 * Legacy (v2-v5) provider-centric encoding.
 */
function encodeBodyLegacy(metadata: PeerMetadata): Uint8Array {
  const parts: Uint8Array[] = [];
  const hasServiceCategoryExtensions = metadata.version >= SERVICE_CATEGORIES_METADATA_VERSION;
  const hasServiceApiProtocolExtensions = metadata.version >= SERVICE_API_PROTOCOLS_METADATA_VERSION;

  // version: 1 byte
  parts.push(new Uint8Array([metadata.version]));

  // peerId: 32 bytes
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

  // offerings
  encodeOfferings(parts, metadata.offerings ?? []);

  // EVM address
  encodeEvmAddress(parts, metadata.evmAddress);

  // On-chain reputation
  encodeOnChainReputation(parts, metadata);

  // Combine all parts
  return combineParts(parts);
}

function encodeOfferings(parts: Uint8Array[], offerings: PeerOffering[]): void {
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
}

function encodeEvmAddress(parts: Uint8Array[], evmAddress: string | undefined): void {
  if (evmAddress) {
    parts.push(new Uint8Array([1]));
    const addrHex = evmAddress.startsWith('0x')
      ? evmAddress.slice(2)
      : evmAddress;
    parts.push(hexToBytes(addrHex.toLowerCase().padStart(40, '0')));
  } else {
    parts.push(new Uint8Array([0]));
  }
}

function encodeOnChainReputation(parts: Uint8Array[], metadata: PeerMetadata): void {
  if (metadata.onChainReputation !== undefined) {
    parts.push(new Uint8Array([1]));
    const repBuf = new ArrayBuffer(10);
    const repView = new DataView(repBuf);
    repView.setUint8(0, Math.min(255, Math.max(0, metadata.onChainReputation)));
    repView.setUint32(1, metadata.onChainSessionCount ?? 0, false);
    repView.setUint32(5, metadata.onChainDisputeCount ?? 0, false);
    repView.setUint8(9, 0); // reserved
    parts.push(new Uint8Array(repBuf));
  } else {
    parts.push(new Uint8Array([0]));
  }
}

function combineParts(parts: Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/**
 * Decode binary metadata back into PeerMetadata.
 * Handles both v6+ (service-centric) and v2-v5 (provider-centric) formats.
 */
export function decodeMetadata(data: Uint8Array): PeerMetadata {
  function checkBounds(offset: number, needed: number, total: number): void {
    if (offset + needed > total) throw new Error('Truncated metadata buffer');
  }

  // Peek at version byte to determine format
  checkBounds(0, 1, data.length);
  const version = data[0]!;

  if (version >= SERVICE_CENTRIC_METADATA_VERSION) {
    return decodeV6(data, checkBounds);
  }
  return decodeLegacy(data, checkBounds);
}

/**
 * Decode v6+ service-centric format.
 */
function decodeV6(
  data: Uint8Array,
  checkBounds: (offset: number, needed: number, total: number) => void,
): PeerMetadata {
  let offset = 0;

  // version: 1 byte
  checkBounds(offset, 1, data.length);
  const version = data[offset]!;
  offset += 1;

  // peerId: 32 bytes
  checkBounds(offset, 32, data.length);
  const peerIdBytes = data.slice(offset, offset + 32);
  const peerId = bytesToHex(peerIdBytes);
  offset += 32;

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

  // serviceCount: 1 byte
  checkBounds(offset, 1, data.length);
  const serviceCount = data[offset]!;
  offset += 1;

  const services: ServiceAnnouncement[] = [];
  for (let i = 0; i < serviceCount; i++) {
    // name: length-prefixed
    checkBounds(offset, 1, data.length);
    const nameLen = data[offset]!;
    offset += 1;
    checkBounds(offset, nameLen, data.length);
    const name = new TextDecoder().decode(data.slice(offset, offset + nameLen));
    offset += nameLen;

    // input price: 4 bytes float32
    checkBounds(offset, 4, data.length);
    const inputUsdPerMillion = new DataView(data.buffer, data.byteOffset + offset, 4).getFloat32(0, false);
    offset += 4;

    // output price: 4 bytes float32
    checkBounds(offset, 4, data.length);
    const outputUsdPerMillion = new DataView(data.buffer, data.byteOffset + offset, 4).getFloat32(0, false);
    offset += 4;

    // protocols
    checkBounds(offset, 1, data.length);
    const protocolCount = data[offset]!;
    offset += 1;
    const protocols: ServiceApiProtocol[] = [];
    for (let j = 0; j < protocolCount; j++) {
      checkBounds(offset, 1, data.length);
      const protocolLen = data[offset]!;
      offset += 1;
      checkBounds(offset, protocolLen, data.length);
      const protocol = new TextDecoder().decode(data.slice(offset, offset + protocolLen));
      offset += protocolLen;
      protocols.push(protocol as ServiceApiProtocol);
    }

    // categories
    checkBounds(offset, 1, data.length);
    const categoryCount = data[offset]!;
    offset += 1;
    const categories: string[] = [];
    for (let j = 0; j < categoryCount; j++) {
      checkBounds(offset, 1, data.length);
      const categoryLen = data[offset]!;
      offset += 1;
      checkBounds(offset, categoryLen, data.length);
      const category = new TextDecoder().decode(data.slice(offset, offset + categoryLen));
      offset += categoryLen;
      categories.push(category);
    }

    services.push({
      name,
      pricing: { inputUsdPerMillion, outputUsdPerMillion },
      ...(protocols.length > 0 ? { protocols } : {}),
      ...(categories.length > 0 ? { categories } : {}),
    });
  }

  // peer-level maxConcurrency: 2 bytes uint16
  checkBounds(offset, 2, data.length);
  const maxConcurrency = new DataView(data.buffer, data.byteOffset + offset, 2).getUint16(0, false);
  offset += 2;

  // peer-level currentLoad: 2 bytes uint16
  checkBounds(offset, 2, data.length);
  const currentLoad = new DataView(data.buffer, data.byteOffset + offset, 2).getUint16(0, false);
  offset += 2;

  // displayName
  let displayName: string | undefined;
  checkBounds(offset, 1, data.length - 64);
  const displayNameFlag = data[offset]!;
  offset += 1;
  if (displayNameFlag === 1) {
    checkBounds(offset, 1, data.length - 64);
    const displayNameLen = data[offset]!;
    offset += 1;
    checkBounds(offset, displayNameLen, data.length - 64);
    displayName = new TextDecoder().decode(data.slice(offset, offset + displayNameLen));
    offset += displayNameLen;
  }

  // publicAddress
  let publicAddress: string | undefined;
  checkBounds(offset, 1, data.length - 64);
  const publicAddressFlag = data[offset]!;
  offset += 1;
  if (publicAddressFlag === 1) {
    checkBounds(offset, 1, data.length - 64);
    const publicAddressLen = data[offset]!;
    offset += 1;
    checkBounds(offset, publicAddressLen, data.length - 64);
    publicAddress = new TextDecoder().decode(data.slice(offset, offset + publicAddressLen));
    offset += publicAddressLen;
  }

  // offerings, evm, reputation — shared trailer
  const trailer = decodeTrailer(data, offset, checkBounds);
  offset = trailer.offset;

  // signature: 64 bytes
  checkBounds(offset, 64, data.length);
  const signatureBytes = data.slice(offset, offset + 64);
  const signature = bytesToHex(signatureBytes);

  return {
    peerId: toPeerId(peerId),
    version,
    ...(displayName ? { displayName } : {}),
    ...(publicAddress ? { publicAddress } : {}),
    services,
    providers: [],
    maxConcurrency,
    currentLoad,
    ...(trailer.offerings && trailer.offerings.length > 0 ? { offerings: trailer.offerings } : {}),
    ...(trailer.evmAddress !== undefined ? { evmAddress: trailer.evmAddress } : {}),
    ...(trailer.onChainReputation !== undefined ? { onChainReputation: trailer.onChainReputation } : {}),
    ...(trailer.onChainSessionCount !== undefined ? { onChainSessionCount: trailer.onChainSessionCount } : {}),
    ...(trailer.onChainDisputeCount !== undefined ? { onChainDisputeCount: trailer.onChainDisputeCount } : {}),
    region,
    timestamp,
    signature,
  };
}

/**
 * Decode legacy (v2-v5) provider-centric format and convert to service-centric.
 */
function decodeLegacy(
  data: Uint8Array,
  checkBounds: (offset: number, needed: number, total: number) => void,
): PeerMetadata {
  let offset = 0;

  // version: 1 byte
  checkBounds(offset, 1, data.length);
  const version = data[offset]!;
  const hasServiceCategoryExtensions = version >= SERVICE_CATEGORIES_METADATA_VERSION;
  const hasServiceApiProtocolExtensions = version >= SERVICE_API_PROTOCOLS_METADATA_VERSION;
  const hasPublicAddressExtension = version >= PUBLIC_ADDRESS_METADATA_VERSION;
  offset += 1;

  // peerId: 32 bytes
  checkBounds(offset, 32, data.length);
  const peerIdBytes = data.slice(offset, offset + 32);
  const peerId = bytesToHex(peerIdBytes);
  offset += 32;

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

  const providers: ProviderAnnouncement[] = [];
  let totalMaxConcurrency = 0;
  let totalCurrentLoad = 0;

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

    const providerServices: string[] = [];
    for (let j = 0; j < serviceCount; j++) {
      checkBounds(offset, 1, data.length);
      const serviceLen = data[offset]!;
      offset += 1;
      checkBounds(offset, serviceLen, data.length);
      const service = new TextDecoder().decode(data.slice(offset, offset + serviceLen));
      offset += serviceLen;
      providerServices.push(service);
    }

    // default input price: 4 bytes float32
    checkBounds(offset, 4, data.length);
    const defaultInputUsdPerMillion = new DataView(data.buffer, data.byteOffset + offset, 4).getFloat32(0, false);
    offset += 4;

    // default output price: 4 bytes float32
    checkBounds(offset, 4, data.length);
    const defaultOutputUsdPerMillion = new DataView(data.buffer, data.byteOffset + offset, 4).getFloat32(0, false);
    offset += 4;

    // servicePricing entries
    checkBounds(offset, 1, data.length);
    const servicePricingCount = data[offset]!;
    offset += 1;

    const servicePricing: Record<string, { inputUsdPerMillion: number; outputUsdPerMillion: number }> = {};
    for (let j = 0; j < servicePricingCount; j++) {
      checkBounds(offset, 1, data.length);
      const pricedServiceLen = data[offset]!;
      offset += 1;
      checkBounds(offset, pricedServiceLen, data.length);
      const pricedServiceName = new TextDecoder().decode(data.slice(offset, offset + pricedServiceLen));
      offset += pricedServiceLen;

      checkBounds(offset, 4, data.length);
      const inputUsdPerMillion = new DataView(data.buffer, data.byteOffset + offset, 4).getFloat32(0, false);
      offset += 4;

      checkBounds(offset, 4, data.length);
      const outputUsdPerMillion = new DataView(data.buffer, data.byteOffset + offset, 4).getFloat32(0, false);
      offset += 4;

      servicePricing[pricedServiceName] = { inputUsdPerMillion, outputUsdPerMillion };
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

    // maxConcurrency: 2 bytes uint16
    checkBounds(offset, 2, data.length);
    const maxConcurrency = new DataView(data.buffer, data.byteOffset + offset, 2).getUint16(0, false);
    offset += 2;

    // currentLoad: 2 bytes uint16
    checkBounds(offset, 2, data.length);
    const currentLoadVal = new DataView(data.buffer, data.byteOffset + offset, 2).getUint16(0, false);
    offset += 2;

    totalMaxConcurrency += maxConcurrency;
    totalCurrentLoad += currentLoadVal;

    providers.push({
      provider,
      services: providerServices,
      defaultPricing: {
        inputUsdPerMillion: defaultInputUsdPerMillion,
        outputUsdPerMillion: defaultOutputUsdPerMillion,
      },
      ...(servicePricingCount > 0 ? { servicePricing } : {}),
      ...(serviceCategories && Object.keys(serviceCategories).length > 0 ? { serviceCategories } : {}),
      ...(serviceApiProtocols && Object.keys(serviceApiProtocols).length > 0 ? { serviceApiProtocols } : {}),
      maxConcurrency,
      currentLoad: currentLoadVal,
    });
  }

  let displayName: string | undefined;
  if (hasServiceCategoryExtensions) {
    checkBounds(offset, 1, data.length - 64);
    const displayNameFlag = data[offset]!;
    offset += 1;
    if (displayNameFlag === 1) {
      checkBounds(offset, 1, data.length - 64);
      const displayNameLen = data[offset]!;
      offset += 1;
      checkBounds(offset, displayNameLen, data.length - 64);
      displayName = new TextDecoder().decode(data.slice(offset, offset + displayNameLen));
      offset += displayNameLen;
    }
  }

  let publicAddress: string | undefined;
  if (hasPublicAddressExtension) {
    checkBounds(offset, 1, data.length - 64);
    const publicAddressFlag = data[offset]!;
    offset += 1;
    if (publicAddressFlag === 1) {
      checkBounds(offset, 1, data.length - 64);
      const publicAddressLen = data[offset]!;
      offset += 1;
      checkBounds(offset, publicAddressLen, data.length - 64);
      publicAddress = new TextDecoder().decode(data.slice(offset, offset + publicAddressLen));
      offset += publicAddressLen;
    }
  }

  // offerings, evm, reputation — shared trailer
  const trailer = decodeTrailer(data, offset, checkBounds);
  offset = trailer.offset;

  // signature: 64 bytes
  checkBounds(offset, 64, data.length);
  const signatureBytes = data.slice(offset, offset + 64);
  const signature = bytesToHex(signatureBytes);

  // Convert providers to service announcements
  const services = flattenProvidersToServices(providers);

  return {
    peerId: toPeerId(peerId),
    version,
    ...(displayName ? { displayName } : {}),
    ...(publicAddress ? { publicAddress } : {}),
    services,
    providers,
    maxConcurrency: totalMaxConcurrency,
    currentLoad: totalCurrentLoad,
    ...(trailer.offerings && trailer.offerings.length > 0 ? { offerings: trailer.offerings } : {}),
    ...(trailer.evmAddress !== undefined ? { evmAddress: trailer.evmAddress } : {}),
    ...(trailer.onChainReputation !== undefined ? { onChainReputation: trailer.onChainReputation } : {}),
    ...(trailer.onChainSessionCount !== undefined ? { onChainSessionCount: trailer.onChainSessionCount } : {}),
    ...(trailer.onChainDisputeCount !== undefined ? { onChainDisputeCount: trailer.onChainDisputeCount } : {}),
    region,
    timestamp,
    signature,
  };
}

interface TrailerResult {
  offset: number;
  offerings?: PeerOffering[];
  evmAddress?: string;
  onChainReputation?: number;
  onChainSessionCount?: number;
  onChainDisputeCount?: number;
}

function decodeTrailer(
  data: Uint8Array,
  startOffset: number,
  checkBounds: (offset: number, needed: number, total: number) => void,
): TrailerResult {
  let offset = startOffset;
  const PRICING_UNIT_REVERSE: Array<'token' | 'request' | 'minute' | 'task'> = ['token', 'request', 'minute', 'task'];
  let offerings: PeerOffering[] | undefined;

  const remainingBeforeSignature = data.length - offset - 64;
  if (remainingBeforeSignature >= 2) {
    offerings = [];
    checkBounds(offset, 2, data.length - 64);
    const offeringCount = new DataView(data.buffer, data.byteOffset + offset, 2).getUint16(0, false);
    offset += 2;

    for (let i = 0; i < offeringCount; i++) {
      checkBounds(offset, 1, data.length - 64);
      const capLen = data[offset]!; offset += 1;
      checkBounds(offset, capLen, data.length - 64);
      const capability = new TextDecoder().decode(data.slice(offset, offset + capLen)); offset += capLen;

      checkBounds(offset, 1, data.length - 64);
      const nameLen = data[offset]!; offset += 1;
      checkBounds(offset, nameLen, data.length - 64);
      const name = new TextDecoder().decode(data.slice(offset, offset + nameLen)); offset += nameLen;

      checkBounds(offset, 2, data.length - 64);
      const descLen = new DataView(data.buffer, data.byteOffset + offset, 2).getUint16(0, false); offset += 2;
      checkBounds(offset, descLen, data.length - 64);
      const description = new TextDecoder().decode(data.slice(offset, offset + descLen)); offset += descLen;

      checkBounds(offset, 1, data.length - 64);
      const unit = PRICING_UNIT_REVERSE[data[offset]!] ?? 'token'; offset += 1;

      checkBounds(offset, 4, data.length - 64);
      const pricePerUnit = new DataView(data.buffer, data.byteOffset + offset, 4).getFloat32(0, false); offset += 4;

      checkBounds(offset, 1, data.length - 64);
      const offeringServiceCount = data[offset]!; offset += 1;
      const offeringServices: string[] = [];
      for (let j = 0; j < offeringServiceCount; j++) {
        checkBounds(offset, 1, data.length - 64);
        const serviceLen = data[offset]!; offset += 1;
        checkBounds(offset, serviceLen, data.length - 64);
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

  // Optional EVM address
  let evmAddress: string | undefined;
  const remainingBeforeEvmSig = data.length - offset - 64;
  if (remainingBeforeEvmSig >= 1) {
    const evmFlag = data[offset]!;
    offset += 1;
    if (evmFlag === 1) {
      checkBounds(offset, 20, data.length - 64);
      const addrBytes = data.slice(offset, offset + 20);
      evmAddress = '0x' + bytesToHex(addrBytes);
      offset += 20;
    }
  }

  // Optional on-chain reputation
  let onChainReputation: number | undefined;
  let onChainSessionCount: number | undefined;
  let onChainDisputeCount: number | undefined;
  const remainingBeforeRepSig = data.length - offset - 64;
  if (remainingBeforeRepSig >= 1) {
    const repFlag = data[offset]!;
    offset += 1;
    if (repFlag === 1) {
      checkBounds(offset, 10, data.length - 64);
      const repView = new DataView(data.buffer, data.byteOffset + offset, 10);
      onChainReputation = repView.getUint8(0);
      onChainSessionCount = repView.getUint32(1, false);
      onChainDisputeCount = repView.getUint32(5, false);
      offset += 10;
    }
  }

  return {
    offset,
    offerings,
    evmAddress,
    onChainReputation,
    onChainSessionCount,
    onChainDisputeCount,
  };
}

/**
 * Convert legacy ProviderAnnouncement[] to ServiceAnnouncement[].
 * Each provider's services become individual ServiceAnnouncement entries.
 */
function flattenProvidersToServices(providers: ProviderAnnouncement[]): ServiceAnnouncement[] {
  const services: ServiceAnnouncement[] = [];
  const seen = new Set<string>();

  for (const p of providers) {
    for (const serviceName of p.services) {
      if (seen.has(serviceName)) continue;
      seen.add(serviceName);

      const pricing = p.servicePricing?.[serviceName] ?? p.defaultPricing;
      const categories = p.serviceCategories?.[serviceName];
      const protocols = p.serviceApiProtocols?.[serviceName];

      services.push({
        name: serviceName,
        pricing: {
          inputUsdPerMillion: pricing.inputUsdPerMillion,
          outputUsdPerMillion: pricing.outputUsdPerMillion,
        },
        ...(protocols && protocols.length > 0 ? { protocols } : {}),
        ...(categories && categories.length > 0 ? { categories } : {}),
      });
    }
  }

  return services;
}
