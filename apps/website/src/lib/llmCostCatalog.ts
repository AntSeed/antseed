export const ANTSEED_PROTOCOL_FEE_RATE = 0.04;

export interface SellerOffer {
  sellerId: string;
  sellerName: string;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

export interface CostCatalogModel {
  id: string;
  name: string;
  provider: string;
  openRouterInputUsdPerMillion: number;
  openRouterOutputUsdPerMillion: number;
  offers: SellerOffer[];
  sellerCount: number;
}

export interface CostComparison {
  openRouterCost: number;
  antseedCost: number;
  difference: number;
  differencePercent: number;
  bestOffer: SellerOffer;
}

interface OpenRouterModel {
  id?: unknown;
  name?: unknown;
  pricing?: {
    prompt?: unknown;
    completion?: unknown;
  };
}

interface AntseedOffering {
  service?: unknown;
  sellerAddress?: unknown;
  peerId?: unknown;
  sellerName?: unknown;
  inputUsdPerMillion?: unknown;
  outputUsdPerMillion?: unknown;
}

interface ParsedOpenRouterModel {
  id: string;
  name: string;
  provider: string;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

const NON_ALPHANUMERIC = /[^a-z0-9]/g;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeModelId(value: string): string {
  return value.toLowerCase().replace(NON_ALPHANUMERIC, '');
}

function modelSlug(value: string): string {
  const slash = value.indexOf('/');
  return normalizeModelId(slash >= 0 ? value.slice(slash + 1) : value);
}

function positiveNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function perTokenToPerMillion(value: unknown): number | null {
  const number = positiveNumber(value);
  return number === null ? null : number * 1_000_000;
}

function titleFromSlug(value: string): string {
  return value
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function parseOpenRouterModel(value: unknown): ParsedOpenRouterModel | null {
  const model = asRecord(value) as OpenRouterModel | null;
  if (!model || typeof model.id !== 'string') return null;

  const inputUsdPerMillion = perTokenToPerMillion(model.pricing?.prompt);
  const outputUsdPerMillion = perTokenToPerMillion(model.pricing?.completion);
  if (inputUsdPerMillion === null || outputUsdPerMillion === null) return null;

  const rawName = typeof model.name === 'string' && model.name.trim() ? model.name.trim() : model.id;
  const providerFromName = rawName.includes(':') ? rawName.split(':', 1)[0].trim() : '';
  const providerSlug = model.id.split('/', 1)[0];
  const name = rawName.includes(':') ? rawName.slice(rawName.indexOf(':') + 1).trim() : rawName;

  return {
    id: model.id,
    name,
    provider: providerFromName || titleFromSlug(providerSlug),
    inputUsdPerMillion,
    outputUsdPerMillion,
  };
}

function addUniqueIndex(
  index: Map<string, ParsedOpenRouterModel | null>,
  key: string,
  model: ParsedOpenRouterModel,
): void {
  if (!key) return;
  const existing = index.get(key);
  if (existing === undefined) {
    index.set(key, model);
  } else if (existing.id !== model.id) {
    index.set(key, null);
  }
}

function parseSellerOffer(value: unknown): {service: string; offer: SellerOffer} | null {
  const offering = asRecord(value) as AntseedOffering | null;
  if (!offering || typeof offering.service !== 'string' || !offering.service.trim()) return null;

  const inputUsdPerMillion = positiveNumber(offering.inputUsdPerMillion);
  const outputUsdPerMillion = positiveNumber(offering.outputUsdPerMillion);
  if (inputUsdPerMillion === null || outputUsdPerMillion === null) return null;

  const sellerId = [offering.sellerAddress, offering.peerId, offering.sellerName]
    .find((candidate) => typeof candidate === 'string' && candidate.trim()) as string | undefined;
  if (!sellerId) return null;

  const sellerName =
    typeof offering.sellerName === 'string' && offering.sellerName.trim()
      ? offering.sellerName.trim()
      : `${sellerId.slice(0, 6)}…${sellerId.slice(-4)}`;

  return {
    service: offering.service,
    offer: {sellerId, sellerName, inputUsdPerMillion, outputUsdPerMillion},
  };
}

export function buildCostCatalog(networkPayload: unknown, openRouterPayload: unknown): CostCatalogModel[] {
  const network = asRecord(networkPayload);
  const openRouter = asRecord(openRouterPayload);
  const referenceModels = asArray(openRouter?.data)
    .map(parseOpenRouterModel)
    .filter((model): model is ParsedOpenRouterModel => model !== null);

  const exactIndex = new Map<string, ParsedOpenRouterModel | null>();
  const slugIndex = new Map<string, ParsedOpenRouterModel | null>();
  for (const model of referenceModels) {
    addUniqueIndex(exactIndex, normalizeModelId(model.id), model);
    addUniqueIndex(slugIndex, modelSlug(model.id), model);
  }

  const offersByModel = new Map<string, SellerOffer[]>();
  for (const rawOffering of asArray(network?.offerings)) {
    const parsed = parseSellerOffer(rawOffering);
    if (!parsed) continue;

    const exactMatch = exactIndex.get(normalizeModelId(parsed.service));
    const slugMatch = slugIndex.get(modelSlug(parsed.service));
    const model = exactMatch || slugMatch;
    if (!model) continue;

    const offers = offersByModel.get(model.id);
    if (offers) offers.push(parsed.offer);
    else offersByModel.set(model.id, [parsed.offer]);
  }

  return referenceModels
    .flatMap((model): CostCatalogModel[] => {
      const offers = offersByModel.get(model.id);
      if (!offers?.length) return [];
      return [
        {
          id: model.id,
          name: model.name,
          provider: model.provider,
          openRouterInputUsdPerMillion: model.inputUsdPerMillion,
          openRouterOutputUsdPerMillion: model.outputUsdPerMillion,
          offers,
          sellerCount: new Set(offers.map((offer) => offer.sellerId)).size,
        },
      ];
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function workloadCost(
  inputMillions: number,
  outputMillions: number,
  inputUsdPerMillion: number,
  outputUsdPerMillion: number,
): number {
  return inputMillions * inputUsdPerMillion + outputMillions * outputUsdPerMillion;
}

export function compareModelCost(
  model: CostCatalogModel,
  inputMillions: number,
  outputMillions: number,
): CostComparison {
  const safeInput = Number.isFinite(inputMillions) ? Math.max(0, inputMillions) : 0;
  const safeOutput = Number.isFinite(outputMillions) ? Math.max(0, outputMillions) : 0;
  const openRouterCost = workloadCost(
    safeInput,
    safeOutput,
    model.openRouterInputUsdPerMillion,
    model.openRouterOutputUsdPerMillion,
  );

  let bestOffer = model.offers[0];
  let antseedCost = Number.POSITIVE_INFINITY;
  for (const offer of model.offers) {
    const cost =
      workloadCost(safeInput, safeOutput, offer.inputUsdPerMillion, offer.outputUsdPerMillion) *
      (1 + ANTSEED_PROTOCOL_FEE_RATE);
    if (cost < antseedCost) {
      bestOffer = offer;
      antseedCost = cost;
    }
  }

  const difference = openRouterCost - antseedCost;
  const differencePercent = openRouterCost > 0 ? (difference / openRouterCost) * 100 : 0;
  return {openRouterCost, antseedCost, difference, differencePercent, bestOffer};
}

export function pickFeaturedModel(
  catalog: CostCatalogModel[],
  inputMillions: number,
  outputMillions: number,
): CostCatalogModel | null {
  let featured: CostCatalogModel | null = null;
  let largestSaving = Number.NEGATIVE_INFINITY;
  for (const model of catalog) {
    const saving = compareModelCost(model, inputMillions, outputMillions).difference;
    if (saving > largestSaving) {
      featured = model;
      largestSaving = saving;
    }
  }
  return featured;
}

