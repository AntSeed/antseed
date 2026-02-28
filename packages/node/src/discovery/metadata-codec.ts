import type { PeerMetadata } from "./peer-metadata.js";
import type { PeerOffering } from "../types/capability.js";
import { hexToBytes, bytesToHex } from "../utils/hex.js";
import { toPeerId } from "../types/peer.js";
import type { ModelApiProtocol } from "../types/model-api.js";
import { isKnownModelApiProtocol } from "../types/model-api.js";

const MODEL_CATEGORIES_METADATA_VERSION = 3;
const MODEL_API_PROTOCOLS_METADATA_VERSION = 4;

/**
 * Encode metadata into binary format:
 * [version:1][peerId:32][regionLen:1][region:N][timestamp:8 BigUint64][providerCount:1]
 * for each provider:
 *   [providerLen:1][provider:N][modelCount:1][models...]
 *   [defaultInputPrice:4][defaultOutputPrice:4]
 *   [modelPricingCount:1][modelPricingEntries...]
 *   [modelCategoryCount:1][modelCategoryEntries...] (v3+ only)
 *   [modelApiProtocolCount:1][modelApiProtocolEntries...] (v4+ only)
 *   [maxConcurrency:2][currentLoad:2]
 * modelPricingEntry: [modelLen:1][model:N][inputPrice:4][outputPrice:4]
 * modelCategoryEntry(v3+): [modelLen:1][model:N][categoryCount:1][categories...]
 * category(v3+): [categoryLen:1][category:N]
 * modelApiProtocolEntry(v4+): [modelLen:1][model:N][protocolCount:1][protocols...]
 * protocol(v4+): [protocolLen:1][protocol:N]
 * [displayNameFlag:1][displayNameLen:1][displayName:N] (v3+ only)
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
  const parts: Uint8Array[] = [];
  const hasModelCategoryExtensions = metadata.version >= MODEL_CATEGORIES_METADATA_VERSION;
  const hasModelApiProtocolExtensions = metadata.version >= MODEL_API_PROTOCOLS_METADATA_VERSION;

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

    // modelCount: 1 byte
    parts.push(new Uint8Array([p.models.length]));

    // each model: length-prefixed
    for (const model of p.models) {
      const modelBytes = new TextEncoder().encode(model);
      parts.push(new Uint8Array([modelBytes.length]));
      parts.push(modelBytes);
    }

    // default input price: 4 bytes (float32)
    const inputPriceBuf = new ArrayBuffer(4);
    new DataView(inputPriceBuf).setFloat32(0, p.defaultPricing.inputUsdPerMillion, false);
    parts.push(new Uint8Array(inputPriceBuf));

    // default output price: 4 bytes (float32)
    const outputPriceBuf = new ArrayBuffer(4);
    new DataView(outputPriceBuf).setFloat32(0, p.defaultPricing.outputUsdPerMillion, false);
    parts.push(new Uint8Array(outputPriceBuf));

    // modelPricing entries
    const modelPricingEntries = Object.entries(p.modelPricing ?? {}).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    parts.push(new Uint8Array([modelPricingEntries.length]));
    for (const [modelName, pricing] of modelPricingEntries) {
      const modelNameBytes = new TextEncoder().encode(modelName);
      parts.push(new Uint8Array([modelNameBytes.length]));
      parts.push(modelNameBytes);

      const modelInputBuf = new ArrayBuffer(4);
      new DataView(modelInputBuf).setFloat32(0, pricing.inputUsdPerMillion, false);
      parts.push(new Uint8Array(modelInputBuf));

      const modelOutputBuf = new ArrayBuffer(4);
      new DataView(modelOutputBuf).setFloat32(0, pricing.outputUsdPerMillion, false);
      parts.push(new Uint8Array(modelOutputBuf));
    }

    if (hasModelCategoryExtensions) {
      const modelCategoryEntries = Object.entries(p.modelCategories ?? {})
        .map(([modelName, categories]) => {
          const normalizedCategories = Array.from(
            new Set(
              categories
                .map((category) => category.trim().toLowerCase())
                .filter((category) => category.length > 0),
            ),
          ).sort();
          return [modelName, normalizedCategories] as const;
        })
        .filter(([, categories]) => categories.length > 0)
        .sort(([a], [b]) => a.localeCompare(b));

      parts.push(new Uint8Array([modelCategoryEntries.length]));
      for (const [modelName, categories] of modelCategoryEntries) {
        const modelNameBytes = new TextEncoder().encode(modelName);
        parts.push(new Uint8Array([modelNameBytes.length]));
        parts.push(modelNameBytes);
        parts.push(new Uint8Array([categories.length]));
        for (const category of categories) {
          const categoryBytes = new TextEncoder().encode(category);
          parts.push(new Uint8Array([categoryBytes.length]));
          parts.push(categoryBytes);
        }
      }
    }

    if (hasModelApiProtocolExtensions) {
      const modelApiProtocolEntries = Object.entries(p.modelApiProtocols ?? {})
        .map(([modelName, protocols]) => {
          const normalizedProtocols = Array.from(
            new Set(
              protocols
                .map((protocol) => protocol.trim().toLowerCase())
                .filter((protocol): protocol is ModelApiProtocol => isKnownModelApiProtocol(protocol)),
            ),
          ).sort();
          return [modelName, normalizedProtocols] as const;
        })
        .filter(([, protocols]) => protocols.length > 0)
        .sort(([a], [b]) => a.localeCompare(b));

      parts.push(new Uint8Array([modelApiProtocolEntries.length]));
      for (const [modelName, protocols] of modelApiProtocolEntries) {
        const modelNameBytes = new TextEncoder().encode(modelName);
        parts.push(new Uint8Array([modelNameBytes.length]));
        parts.push(modelNameBytes);
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

  if (hasModelCategoryExtensions) {
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

    const models = o.models ?? [];
    parts.push(new Uint8Array([models.length]));
    for (const model of models) {
      const modelBytes = new TextEncoder().encode(model);
      parts.push(new Uint8Array([modelBytes.length]));
      parts.push(modelBytes);
    }
  }

  // EVM address: 1 flag byte + 20 address bytes if present
  if (metadata.evmAddress) {
    parts.push(new Uint8Array([1])); // flag: present
    // Strip 0x prefix if present, then decode 20 bytes
    const addrHex = metadata.evmAddress.startsWith('0x')
      ? metadata.evmAddress.slice(2)
      : metadata.evmAddress;
    parts.push(hexToBytes(addrHex.toLowerCase().padStart(40, '0')));
  } else {
    parts.push(new Uint8Array([0])); // flag: absent
  }

  // On-chain reputation: 1 flag byte + 10 data bytes (1 reputation + 4 sessionCount + 4 disputeCount + 1 reserved)
  if (metadata.onChainReputation !== undefined) {
    parts.push(new Uint8Array([1])); // flag: present
    const repBuf = new ArrayBuffer(10);
    const repView = new DataView(repBuf);
    repView.setUint8(0, Math.min(255, Math.max(0, metadata.onChainReputation)));
    repView.setUint32(1, metadata.onChainSessionCount ?? 0, false);
    repView.setUint32(5, metadata.onChainDisputeCount ?? 0, false);
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
  const hasModelCategoryExtensions = version >= MODEL_CATEGORIES_METADATA_VERSION;
  const hasModelApiProtocolExtensions = version >= MODEL_API_PROTOCOLS_METADATA_VERSION;
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

  const providers = [];
  for (let i = 0; i < providerCount; i++) {
    // provider name: length-prefixed
    checkBounds(offset, 1, data.length);
    const providerLen = data[offset]!;
    offset += 1;
    checkBounds(offset, providerLen, data.length);
    const provider = new TextDecoder().decode(data.slice(offset, offset + providerLen));
    offset += providerLen;

    // modelCount: 1 byte
    checkBounds(offset, 1, data.length);
    const modelCount = data[offset]!;
    offset += 1;

    const models: string[] = [];
    for (let j = 0; j < modelCount; j++) {
      checkBounds(offset, 1, data.length);
      const modelLen = data[offset]!;
      offset += 1;
      checkBounds(offset, modelLen, data.length);
      const model = new TextDecoder().decode(data.slice(offset, offset + modelLen));
      offset += modelLen;
      models.push(model);
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

    // modelPricing entries
    checkBounds(offset, 1, data.length);
    const modelPricingCount = data[offset]!;
    offset += 1;

    const modelPricing: Record<string, { inputUsdPerMillion: number; outputUsdPerMillion: number }> = {};
    for (let j = 0; j < modelPricingCount; j++) {
      checkBounds(offset, 1, data.length);
      const pricedModelLen = data[offset]!;
      offset += 1;
      checkBounds(offset, pricedModelLen, data.length);
      const pricedModelName = new TextDecoder().decode(data.slice(offset, offset + pricedModelLen));
      offset += pricedModelLen;

      checkBounds(offset, 4, data.length);
      const pricedInputView = new DataView(data.buffer, data.byteOffset + offset, 4);
      const inputUsdPerMillion = pricedInputView.getFloat32(0, false);
      offset += 4;

      checkBounds(offset, 4, data.length);
      const pricedOutputView = new DataView(data.buffer, data.byteOffset + offset, 4);
      const outputUsdPerMillion = pricedOutputView.getFloat32(0, false);
      offset += 4;

      modelPricing[pricedModelName] = {
        inputUsdPerMillion,
        outputUsdPerMillion,
      };
    }

    let modelCategories: Record<string, string[]> | undefined;
    if (hasModelCategoryExtensions) {
      checkBounds(offset, 1, data.length);
      const modelCategoryCount = data[offset]!;
      offset += 1;
      if (modelCategoryCount > 0) {
        modelCategories = {};
        for (let j = 0; j < modelCategoryCount; j++) {
          checkBounds(offset, 1, data.length);
          const categorizedModelLen = data[offset]!;
          offset += 1;
          checkBounds(offset, categorizedModelLen, data.length);
          const categorizedModelName = new TextDecoder().decode(data.slice(offset, offset + categorizedModelLen));
          offset += categorizedModelLen;

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
          modelCategories[categorizedModelName] = categories;
        }
      }
    }

    let modelApiProtocols: Record<string, ModelApiProtocol[]> | undefined;
    if (hasModelApiProtocolExtensions) {
      checkBounds(offset, 1, data.length);
      const modelApiProtocolCount = data[offset]!;
      offset += 1;
      if (modelApiProtocolCount > 0) {
        modelApiProtocols = {};
        for (let j = 0; j < modelApiProtocolCount; j++) {
          checkBounds(offset, 1, data.length);
          const protocolModelLen = data[offset]!;
          offset += 1;
          checkBounds(offset, protocolModelLen, data.length);
          const protocolModelName = new TextDecoder().decode(data.slice(offset, offset + protocolModelLen));
          offset += protocolModelLen;

          checkBounds(offset, 1, data.length);
          const protocolCount = data[offset]!;
          offset += 1;
          const protocols: ModelApiProtocol[] = [];
          for (let k = 0; k < protocolCount; k++) {
            checkBounds(offset, 1, data.length);
            const protocolLen = data[offset]!;
            offset += 1;
            checkBounds(offset, protocolLen, data.length);
            const protocol = new TextDecoder().decode(data.slice(offset, offset + protocolLen));
            offset += protocolLen;
            protocols.push(protocol as ModelApiProtocol);
          }
          modelApiProtocols[protocolModelName] = protocols;
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
      models,
      defaultPricing: {
        inputUsdPerMillion: defaultInputUsdPerMillion,
        outputUsdPerMillion: defaultOutputUsdPerMillion,
      },
      ...(modelPricingCount > 0 ? { modelPricing } : {}),
      ...(modelCategories && Object.keys(modelCategories).length > 0 ? { modelCategories } : {}),
      ...(modelApiProtocols && Object.keys(modelApiProtocols).length > 0 ? { modelApiProtocols } : {}),
      maxConcurrency,
      currentLoad,
    });
  }

  let displayName: string | undefined;
  if (hasModelCategoryExtensions) {
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

  // offerings
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
      const modelCount = data[offset]!; offset += 1;
      const models: string[] = [];
      for (let j = 0; j < modelCount; j++) {
        checkBounds(offset, 1, data.length - 64);
        const modelLen = data[offset]!; offset += 1;
        checkBounds(offset, modelLen, data.length - 64);
        models.push(new TextDecoder().decode(data.slice(offset, offset + modelLen))); offset += modelLen;
      }

      offerings.push({
        capability: capability as PeerOffering['capability'],
        name, description,
        models: models.length > 0 ? models : undefined,
        pricing: { unit, pricePerUnit, currency: 'USD' },
      });
    }
  }

  // Optional EVM address (flag + 20 bytes) — present if there are enough remaining bytes before signature
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

  // Optional on-chain reputation (flag + 10 bytes)
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
      // byte 9 is reserved
      offset += 10;
    }
  }

  // signature: 64 bytes
  checkBounds(offset, 64, data.length);
  const signatureBytes = data.slice(offset, offset + 64);
  const signature = bytesToHex(signatureBytes);

  return {
    peerId: toPeerId(peerId),
    version,
    ...(displayName ? { displayName } : {}),
    providers,
    ...(offerings && offerings.length > 0 ? { offerings } : {}),
    ...(evmAddress !== undefined ? { evmAddress } : {}),
    ...(onChainReputation !== undefined ? { onChainReputation } : {}),
    ...(onChainSessionCount !== undefined ? { onChainSessionCount } : {}),
    ...(onChainDisputeCount !== undefined ? { onChainDisputeCount } : {}),
    region,
    timestamp,
    signature,
  };
}
