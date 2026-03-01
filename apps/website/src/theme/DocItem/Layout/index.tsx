import React, {useState} from 'react';
import clsx from 'clsx';
import {useWindowSize} from '@docusaurus/theme-common';
import {useDoc} from '@docusaurus/plugin-content-docs/client';
import DocItemPaginator from '@theme/DocItem/Paginator';
import DocVersionBanner from '@theme/DocVersionBanner';
import DocVersionBadge from '@theme/DocVersionBadge';
import DocItemFooter from '@theme/DocItem/Footer';
import DocItemTOCDesktop from '@theme/DocItem/TOC/Desktop';
import DocItemContent from '@theme/DocItem/Content';
import DocBreadcrumbs from '@theme/DocBreadcrumbs';
import ContentVisibility from '@theme/ContentVisibility';
import Link from '@docusaurus/Link';
import styles from './styles.module.css';

const DOC_ITEMS = [
  {label: 'Light Paper', to: '/docs/lightpaper'},
  {label: 'Getting Started', items: [
    {label: 'Introduction', to: '/docs/intro'},
    {label: 'Install', to: '/docs/install'},
    {label: 'Configuration', to: '/docs/configuration'},
  ]},
  {label: 'Protocol', items: [
    {label: 'Overview', to: '/docs/protocol/overview'},
    {label: 'Discovery', to: '/docs/protocol/discovery'},
    {label: 'Transport', to: '/docs/protocol/transport'},
    {label: 'Metering', to: '/docs/protocol/metering'},
    {label: 'Payments', to: '/docs/protocol/payments'},
    {label: 'Reputation', to: '/docs/protocol/reputation'},
  ]},
  {label: 'Skills', items: [
    {label: 'Overview', to: '/docs/skills/overview'},
    {label: 'Creating Skills', to: '/docs/skills/creating-skills'},
  ]},
  {label: 'Plugins', items: [
    {label: 'Provider Plugin', to: '/docs/plugins/provider-plugin'},
    {label: 'Router Plugin', to: '/docs/plugins/router-plugin'},
    {label: 'Creating Plugins', to: '/docs/plugins/creating-plugins'},
  ]},
  {label: 'CLI Reference', items: [
    {label: 'Commands', to: '/docs/cli/commands'},
    {label: 'Flags', to: '/docs/cli/flags'},
  ]},
];

function DocsMenuMobile() {
  const [open, setOpen] = useState(false);
  return (
    <div className="docs-menu-mobile">
      <button
        className={`docs-menu-mobile__btn${open ? ' docs-menu-mobile__btn--open' : ''}`}
        onClick={() => setOpen(!open)}
      >
        Docs menu
        <span className="docs-menu-mobile__arrow">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <ul className="docs-menu-mobile__list" onClick={() => setOpen(false)}>
          {DOC_ITEMS.map((item) => 'to' in item ? (
            <li key={item.to}>
              <Link to={item.to} className="docs-menu-mobile__link">{item.label}</Link>
            </li>
          ) : (
            <li key={item.label}>
              <span className="docs-menu-mobile__category">{item.label}</span>
              <ul>
                {item.items.map((sub) => (
                  <li key={sub.to}>
                    <Link to={sub.to} className="docs-menu-mobile__link docs-menu-mobile__link--sub">{sub.label}</Link>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function useDocTOC() {
  const {frontMatter, toc} = useDoc();
  const windowSize = useWindowSize();
  const hidden = frontMatter.hide_table_of_contents;
  const canRender = !hidden && toc.length > 0;
  const desktop =
    canRender && (windowSize === 'desktop' || windowSize === 'ssr') ? (
      <DocItemTOCDesktop />
    ) : undefined;
  return {hidden, desktop};
}

export default function DocItemLayout({children}) {
  const docTOC = useDocTOC();
  const {metadata} = useDoc();
  return (
    <div className="row">
      <div className={clsx('col', !docTOC.hidden && styles.docItemCol)}>
        <ContentVisibility metadata={metadata} />
        <DocVersionBanner />
        <div className={styles.docItemContainer}>
          <article>
            <DocBreadcrumbs />
            <DocVersionBadge />
            {/* Docs menu replaces "On this page" on mobile */}
            <DocsMenuMobile />
            <DocItemContent>{children}</DocItemContent>
            <DocItemFooter />
          </article>
          <DocItemPaginator />
        </div>
      </div>
      {docTOC.desktop && <div className="col col--3">{docTOC.desktop}</div>}
    </div>
  );
}
