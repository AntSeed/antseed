import React from 'react';
import DefaultNavbarItem, {type Props as DefaultNavbarItemProps} from '@theme/NavbarItem/DefaultNavbarItem';
import {useLatestDesktopDownload} from '@site/src/lib/useLatestDesktopDownload';

/**
 * Navbar "Download VPR" item (`type: 'custom-download'` in docusaurus.config).
 * Same rendering as a plain link navbar item, but the href is resolved at
 * runtime to the direct installer for the visitor's OS/arch, falling back to
 * the releases page when no installer matches (Linux, unknown platforms, or
 * before the release lookup resolves).
 */
export default function DownloadNavbarItem(
  props: Omit<DefaultNavbarItemProps, 'href' | 'to'>,
): React.ReactNode {
  const {href} = useLatestDesktopDownload();
  return <DefaultNavbarItem {...props} href={href} />;
}
