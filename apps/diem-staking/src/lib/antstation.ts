// Smart AntStation download URL — mirrors the pattern from
// `apps/website/src/pages/index.tsx` (`useLatestRelease`) so the "Download
// AntStation" links on diem.antseed.com behave exactly like the ones on
// antseed.com: when the visitor is on a Mac, resolve a direct DMG URL
// matching their CPU arch (Apple Silicon vs Intel) so the click actually
// downloads the installer. On other platforms — or while the GitHub API
// lookup is in-flight — fall back to the releases page.
//
// Keep this file in sync with the website hook. If the release naming
// convention changes, both need updates.

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

export const ANTSTATION_RELEASES_URL = 'https://github.com/AntSeed/antseed/releases/latest';
const GH_API_LATEST = 'https://api.github.com/repos/AntSeed/antseed/releases/latest';

type Arch = 'arm64' | 'x64';

function buildDmgUrl(tag: string, arch: Arch): string {
  const version = tag.replace(/^v/, '');
  const suffix = arch === 'arm64' ? '-arm64' : '';
  return `https://github.com/AntSeed/antseed/releases/download/${tag}/AntSeed-Desktop-${version}${suffix}.dmg`;
}

function detectMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Macintosh|Mac OS X/.test(navigator.userAgent);
}

/** Resolve CPU architecture via the Chromium UserAgentData API. The legacy
 *  UA string always says "Intel" on macOS regardless of chip, so we need
 *  the high-entropy hint. Defaults to arm64 (the majority of Macs since
 *  2020). Silently keeps the default if the API is absent or rejects. */
function useArch(): Arch {
  const [arch, setArch] = useState<Arch>('arm64');
  useEffect(() => {
    const nav = navigator as Navigator & {
      userAgentData?: {
        getHighEntropyValues(hints: string[]): Promise<{ architecture?: string }>;
      };
    };
    if (!nav.userAgentData?.getHighEntropyValues) return;
    nav.userAgentData
      .getHighEntropyValues(['architecture'])
      .then((d) => {
        if (d.architecture === 'x86') setArch('x64');
      })
      .catch(() => {
        /* keep default arm64 */
      });
  }, []);
  return arch;
}

export interface AntstationDownload {
  /** URL to put on the `href`. Direct DMG when resolvable, releases page otherwise. */
  href: string;
  /** True when the resolved href points at a direct DMG (click = real download). */
  isDirectDownload: boolean;
  /** True when the visitor appears to be on macOS (for label switching). */
  isMac: boolean;
}

/**
 * Returns the best AntStation download target for the current visitor.
 * All call-sites on this page should use this in place of hardcoding
 * `ANTSTATION_RELEASES_URL` so the primary CTA always downloads for Mac
 * users and gracefully falls back otherwise.
 *
 * Uses react-query so multiple call-sites share a single cached GitHub API
 * response (the QueryClient is already set up in `main.tsx`).
 */
export function useAntstationDownload(): AntstationDownload {
  const isMac = useMemo(detectMac, []);
  const arch = useArch();

  const { data: tag } = useQuery<string | null>({
    queryKey: ['antstation-latest-release-tag'],
    // GitHub releases change on a ~weekly cadence at most; an hour of
    // staleness is plenty and keeps us well under the unauthenticated API
    // rate limit (60/hr per IP) even if the user opens many tabs.
    staleTime: 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    enabled: isMac,
    retry: 1,
    queryFn: async (): Promise<string | null> => {
      const r = await fetch(GH_API_LATEST);
      if (!r.ok) return null;
      const data = (await r.json()) as { tag_name?: string } | null;
      return data?.tag_name ?? null;
    },
  });

  const href = isMac && tag ? buildDmgUrl(tag, arch) : ANTSTATION_RELEASES_URL;
  return { href, isDirectDownload: isMac && !!tag, isMac };
}
