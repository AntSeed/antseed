import {useCallback, useEffect, useState} from 'react';
import {buildCostCatalog, type CostCatalogModel} from './llmCostCatalog';

const ANTSCAN_NETWORK_API = 'https://antscan.co/api/network';
const OPENROUTER_MODELS_API = 'https://openrouter.ai/api/v1/models';
const REQUEST_TIMEOUT_MS = 12_000;

type CatalogStatus = 'loading' | 'ready' | 'error';

export interface LlmCostCatalogState {
  catalog: CostCatalogModel[];
  status: CatalogStatus;
  error: string | null;
  fetchedAt: number | null;
  networkUpdatedAt: number | null;
  refresh: () => void;
}

async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {signal, headers: {Accept: 'application/json'}});
  if (!response.ok) throw new Error(`Request failed with ${response.status}`);
  return response.json();
}

function networkTimestamp(payload: unknown): number | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const updatedAt = (payload as {updatedAt?: unknown}).updatedAt;
  if (typeof updatedAt === 'number' && Number.isFinite(updatedAt)) return updatedAt;
  if (typeof updatedAt === 'string') {
    const parsed = Date.parse(updatedAt);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

export function useLlmCostCatalog(): LlmCostCatalogState {
  const [requestVersion, setRequestVersion] = useState(0);
  const [catalog, setCatalog] = useState<CostCatalogModel[]>([]);
  const [status, setStatus] = useState<CatalogStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [networkUpdatedAt, setNetworkUpdatedAt] = useState<number | null>(null);
  const refresh = useCallback(() => setRequestVersion((version) => version + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let active = true;
    setCatalog([]);
    setStatus('loading');
    setError(null);

    Promise.all([
      fetchJson(ANTSCAN_NETWORK_API, controller.signal),
      fetchJson(OPENROUTER_MODELS_API, controller.signal),
    ])
      .then(([networkPayload, openRouterPayload]) => {
        if (!active) return;
        const nextCatalog = buildCostCatalog(networkPayload, openRouterPayload);
        if (!nextCatalog.length) throw new Error('The live feeds did not contain any matching priced models.');
        setCatalog(nextCatalog);
        setFetchedAt(Date.now());
        setNetworkUpdatedAt(networkTimestamp(networkPayload));
        setStatus('ready');
      })
      .catch((reason: unknown) => {
        if (!active) return;
        if (controller.signal.aborted) {
          setError('Live pricing took too long to respond. Please try again.');
        } else {
          setError(reason instanceof Error ? reason.message : 'Live pricing is temporarily unavailable.');
        }
        setStatus('error');
      })
      .finally(() => window.clearTimeout(timeout));

    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [requestVersion]);

  return {catalog, status, error, fetchedAt, networkUpdatedAt, refresh};
}
