import type { PeerMetadata } from "./peer-metadata.js";
import type { PeerOffering } from "../types/capability.js";
import { hexToBytes, bytesToHex } from "../utils/hex.js";
import { toPeerId } from "../types/peer.js";
import type { ServiceApiProtocol } from "../types/service-api.js";
import { isKnownServiceApiProtocol } from "../types/service-api.js";

const SERVICE_CATEGORIES_METADATA_VERSION = 3;
const SERVICE_API_PROTOCOLS_METADATA_VERSION = 4;
const PUBLIC_ADDRESS_METADATA_VERSION = 5;

/**
 * Encode metadata into binary format:
 * [version:1][peerId:20][regionLen:1][region:N][timestamp:8 BigUint64][providerCount:1]
 * for each provider:
 *   [providerLen:1][provider:N][serviceCount:1][services...]
 *   [defaultInputPrice:4][defaultOutputPrice:4]
 *   [servicePricingCount:1][servicePricingEntries...]
 *   [serviceCategoryCount:1][serviceCategoryEntries...] (v3+ only)
 *   [serviceApiProtocolCount:1][serviceApiProtocolEntries...] (v4+ only)
 *   [maxConcurrency:2][currentLoad:2]
 * servicePricingEntry: [serviceLen:1][service:N][inputPrice:4][outputPrice:4]
 * serviceCategoryEntry(v3+): [serviceLen:1][service:N][categoryCount:1][categories...]
 * category(v3+): [categoryLen:1][category:N]
 * serviceApiProtocolEntry(v4+): [serviceLen:1][service:N][protocolCount:1][protocols...]
 * protocol(v4+): [protocolLen:1][protocol:N]
 * [displayNameFlag:1][displayNameLen:1][displayName:N] (v3+ only)
 * [publicAddressFlag:1][publicAddressLen:1][publicAddress:N] (v5+ only)
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
  if (version < 6) {
    throw new Error(`Unsupported metadata version ${version}: pre-v6 Ed25519 format is no longer supported`);
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
      const pricedInputView = new DataView(data.buffer, data.byteOffset + offset, 4);
      const inputUsdPerMillion = pricedInputView.getFloat32(0, false);
      offset += 4;

      checkBounds(offset, 4, data.length);
      const pricedOutputView = new DataView(data.buffer, data.byteOffset + offset, 4);
      const outputUsdPerMillion = pricedOutputView.getFloat32(0, false);
      offset += 4;

      servicePricing[pricedServiceName] = {
        inputUsdPerMillion,
        outputUsdPerMillion,
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
      },
      ...(servicePricingCount > 0 ? { servicePricing } : {}),
      ...(serviceCategories && Object.keys(serviceCategories).length > 0 ? { serviceCategories } : {}),
      ...(serviceApiProtocols && Object.keys(serviceApiProtocols).length > 0 ? { serviceApiProtocols } : {}),
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

  // signature: 65 bytes (secp256k1 r+s+v)
  checkBounds(offset, 65, data.length);
  const signatureBytes = data.slice(offset, offset + 65);
  const signature = bytesToHex(signatureBytes);

  return {
    peerId: toPeerId(peerId),
    version,
    ...(displayName ? { displayName } : {}),
    ...(publicAddress ? { publicAddress } : {}),
    providers,
    ...(offerings && offerings.length > 0 ? { offerings } : {}),
    ...(onChainChannelCount !== undefined ? { onChainChannelCount } : {}),
    ...(onChainGhostCount !== undefined ? { onChainGhostCount } : {}),
    region,
    timestamp,
    signature,
  };
}
