import {themes as prismThemes} from 'prism-react-renderer';
import type {Config, Plugin, PluginConfig, PluginModule} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
import integrationsPagesPlugin from './plugins/integrations-pages';
import {integrations as integrationEntries} from './src/integrations/integrations';
import desktopPkg from '../desktop/package.json';

const statsProxyPlugin: PluginModule = () => ({
  name: 'stats-proxy',
  configureWebpack() {
    // Docusaurus merges `config.devServer` during `docusaurus start`, but the
    // exported webpack config type does not include that field.
    return {
      devServer: {
        proxy: [
          {
            context: ['/stats-api'],
            target: 'http://localhost:3001',
            pathRewrite: {'^/stats-api': ''},
            changeOrigin: true,
          },
        ],
      },
    } as unknown as ReturnType<NonNullable<Plugin['configureWebpack']>>;
  },
});

/** Google Tag Manager container for antseed.com. */
const GTM_CONTAINER_ID = process.env.GTM_CONTAINER_ID ?? 'GTM-NHCLBQQK';

/**
 * Typed explicitly: an inline array literal widens to `string | object`, which
 * does not satisfy PluginConfig's [name, options] tuple.
 */
const gtmPlugin: PluginConfig[] = GTM_CONTAINER_ID
  ? [['@docusaurus/plugin-google-tag-manager', {containerId: GTM_CONTAINER_ID}]]
  : [];

const config: Config = {
  title: 'AntSeed',
  tagline: 'The open market for AI inference. No gatekeepers.',
  favicon: 'logo.svg',
  url: 'https://antseed.com',
  baseUrl: '/',
  // The host 308-redirects /path to /path/, so without this Docusaurus emitted
  // canonical tags and sitemap entries pointing at the pre-redirect form: every
  // URL was a redirect source and no page's canonical actually resolved to
  // itself. `true` makes the emitted URLs match what the host already serves.
  trailingSlash: true,
  onBrokenLinks: 'throw',

  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          routeBasePath: 'docs',
          // Feeds the sitemap's `lastmod` from the file's git commit date.
          // Without it every URL carried the build date, so each deploy told
          // crawlers all 59 pages had changed.
          showLastUpdateTime: true,
        },
        pages: {
          showLastUpdateTime: true,
        },
        blog: {
          showLastUpdateTime: true,
          showReadingTime: true,
          blogTitle: 'AntSeed Blog',
          blogDescription: 'Insights on OpenRouter alternatives, P2P AI networks, and the future of AI inference.',
          postsPerPage: 10,
          blogSidebarCount: 'ALL',
        },
        sitemap: {
          lastmod: 'date',
          changefreq: 'weekly',
          priority: 0.5,
          filename: 'sitemap.xml',
          ignorePatterns: ['/tags/**', '/blog/tags/**', '/blog/archive', '/blog/authors'],
        },
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  plugins: [
    // Google Tag Manager. GA4 is configured as a tag *inside* GTM rather than
    // loaded separately, so there is one script on the page and no risk of
    // double-counting pageviews. Adding Ads/LinkedIn/Meta pixels later is a
    // GTM change, not a code change.
    //
    // A GTM container id is public — it ships in the page source — so it lives
    // here rather than in deploy config, and the site works without anyone
    // setting an env var. GTM_CONTAINER_ID still overrides it for staging or a
    // throwaway test container. Set it to an empty string to disable GTM.
    //
    // GA4 (G-DF97Q4KV2X) is configured as a tag *inside* this container, not
    // loaded here, so there is one tag on the page and no double-counting.
    ...gtmPlugin,
    [
      '@docusaurus/plugin-client-redirects',
      {
        redirects: [
          {from: '/lightpaper', to: '/docs/lightpaper'},
          // /connect was renamed to /integrations — keep old links working.
          {from: '/connect', to: '/integrations'},
          {from: '/docs/protocol/transport', to: '/docs/transport'},
          ...integrationEntries.map((i) => ({
            from: `/connect/${i.slug}`,
            to: `/integrations/${i.slug}`,
          })),
        ],
      },
    ],
    statsProxyPlugin,
    integrationsPagesPlugin,
  ],

  // General Sans — the design's display/body face (Geist stays for app-chrome/mono).
  stylesheets: [
    {
      href: 'https://api.fontshare.com/v2/css?f[]=general-sans@400,500,600,700&display=swap',
      type: 'text/css',
    },
  ],

  headTags: [
    // Second Search Console owner. A site can carry several verification tags,
    // one per Google account, and removing one un-verifies that account — so
    // this is additive, not a replacement for the token in themeConfig.metadata.
    //
    // It lives here rather than alongside the other one because themeConfig
    // metadata is rendered through react-helmet, which dedupes <meta> by name:
    // two google-site-verification entries there would collapse into one and
    // this token would silently never ship. headTags is injected verbatim.
    {
      tagName: 'meta',
      attributes: {
        name: 'google-site-verification',
        content: 'wiMhtNPC3UWtvOKXeJBto55Y8F6-7ORyA1aAI_DkZ-A',
      },
    },
    {
      tagName: 'script',
      attributes: {type: 'application/ld+json'},
      innerHTML: JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: 'AntSeed',
        url: 'https://antseed.com',
        description:
          'The open market for AI inference. Serve or consume AI peer-to-peer. Pay per request in USDC. Anonymous by design, with independent providers and no central account.',
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'macOS, Linux, Windows',
        offers: {
          '@type': 'Offer',
          price: '0',
          priceCurrency: 'USD',
          description: 'Free and open-source. Pay only for inference consumed.',
        },
        creator: {
          '@type': 'Organization',
          name: 'AntSeed',
          url: 'https://antseed.com',
          sameAs: [
            'https://github.com/AntSeed/antseed',
            'https://x.com/antseedai',
            'https://t.me/antseed',
          ],
        },
        featureList: [
          'P2P inference routing via DHT',
          'OpenAI Responses API compatible',
          'OpenAI Chat Completions API compatible',
          'Reputation-based provider scoring',
          'TEE attestation for privacy-preserving inference',
          'AI agents with on-demand knowledge and custom tools',
          'Desktop app (VPR)',
          'Agent-to-agent commerce support',
        ],
        downloadUrl: 'https://github.com/AntSeed/antseed/releases',
        softwareVersion: desktopPkg.version,
        license: 'https://github.com/AntSeed/antseed/blob/main/LICENSE',
      }),
    },
  ],

  themeConfig: {
    metadata: [
      {name: 'google-site-verification', content: '09pzs5Q9kHdpQSNSBpr0vNh9SMq-T8lzhBgH5Zgm6ug'},
      {name: 'description', content: 'The open market for AI inference. Every model, no middleman. Anonymous, best price, works with the tools you already use. Owned by no one.'},
      {property: 'og:title', content: 'Every AI model, best price, no middleman'},
      {property: 'og:description', content: 'AntSeed is the open market for AI inference. Every model, no middleman. Anonymous. Best price. Works with the tools you already use. Owned by no one. Available to everyone.'},
      {property: 'og:type', content: 'website'},
      {property: 'og:site_name', content: 'AntSeed'},
      {name: 'twitter:card', content: 'summary_large_image'},
      {name: 'twitter:site', content: '@antseedai'},
      {name: 'twitter:image', content: 'https://antseed.com/og-image.png'},
      {property: 'og:image', content: 'https://antseed.com/og-image.png'},
      {property: 'og:image:width', content: '1200'},
      {property: 'og:image:height', content: '630'},
      {property: 'og:image:alt', content: 'AntSeed, the open market for AI inference'},
    ],
    colorMode: {
      defaultMode: 'light',
      disableSwitch: true,
      respectPrefersColorScheme: false,
    },
    navbar: {
      title: '',
      logo: {
        alt: 'AntSeed',
        src: 'logo-light.svg',
        srcDark: 'logo-dark.svg',
        width: 104,
        height: 36,
      },
      items: [
        {
          href: 'https://antseedstats.com/network',
          label: 'Pricing',
          position: 'left',
          target: '_blank',
          rel: 'noopener noreferrer',
          className: 'header-pricing-link',
        },
        {to: '/integrations', label: 'Integrations', position: 'left'},
        {to: '/providers', label: 'Providers', position: 'left'},
        {to: '/ecosystem', label: 'Ecosystem', position: 'left'},
        {
          type: 'docSidebar',
          sidebarId: 'docs',
          label: 'Docs',
          position: 'right',
          className: 'header-docs-link',
        },
        {to: '/blog', label: 'Blog', position: 'right', className: 'header-blog-link'},
        {
          href: 'https://github.com/antseed',
          'aria-label': 'GitHub',
          position: 'right',
          className: 'header-github-link',
        },
        {
          href: 'https://x.com/antseedai',
          'aria-label': 'X',
          position: 'right',
          className: 'header-x-link',
        },
        {
          href: 'https://t.me/antseed',
          'aria-label': 'Telegram',
          position: 'right',
          className: 'header-telegram-link',
        },
        {
          // Custom item (src/theme/NavbarItem/DownloadNavbarItem.tsx): links
          // straight to the installer for the visitor's OS/arch, falling back
          // to the releases page when detection fails.
          type: 'custom-download',
          label: 'Download VPR',
          position: 'right',
          className: 'header-download-link',
        },
      ],
    },
    prism: {
      theme: prismThemes.nightOwl,
      darkTheme: prismThemes.nightOwl,
      additionalLanguages: ['bash', 'json', 'typescript'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
