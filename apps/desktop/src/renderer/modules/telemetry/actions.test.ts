import { describe, expect, it } from 'vitest';

import { telemetrySurfaceForView } from './actions';

describe('telemetrySurfaceForView', () => {
  it('maps product views to fixed privacy-safe surfaces', () => {
    expect(telemetrySurfaceForView('home')).toBe('home');
    expect(telemetrySurfaceForView('tools')).toBe('apps');
    expect(telemetrySurfaceForView('tunnels')).toBe('tunnels');
    expect(telemetrySurfaceForView('peers')).toBe('peers');
  });
});
