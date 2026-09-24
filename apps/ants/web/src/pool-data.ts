import type { PoolsView } from '../../src/api-types';

export const poolDataOptions = {
  isPartial: (value: PoolsView) => value.source === 'chain' && !!value.sourceError,
  retryOnError: false,
};
