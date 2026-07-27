import {themes as prismThemes} from 'prism-react-renderer';
import type {Config, Plugin, PluginModule} from '@docusaurus/types';
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

const config: Config = {
  title: 'AntSeed',
  tagline: 'The open market for AI inference. No gatekeepers.',
  favicon: 'logo.svg',
  url: 'https://antseed.com',
  baseUrl: '/',
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
        },
        blog: {
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
    [
      '@docusaurus/plugin-client-redirects',
      {
        redirects: [
          {from: '/lightpaper', to: '/docs/lightpaper'},
          // /connect was renamed to /integrations — keep old links working.
          {from: '/connect', to: '/integrations'},
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
          'Desktop app (AntStation)',
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
      {name: 'keywords', content: 'AI marketplace, OpenRouter alternative, serving AI inference, consuming AI inference, peer-to-peer AI, decentralized AI inference, anonymous AI, private AI, P2P AI, AI economy'},
      {name: 'description', content: 'Permissionless peer-to-peer AI inference. Pay per request in USDC. Anonymous by design, with independent providers and no central account.'},
      {property: 'og:title', content: 'AntSeed — The open market for AI inference'},
      {property: 'og:description', content: 'Permissionless peer-to-peer AI inference. Pay per request in USDC. Anonymous by design, with independent providers and no central account.'},
      {property: 'og:type', content: 'website'},
      {name: 'twitter:card', content: 'summary_large_image'},
      {name: 'twitter:image', content: 'https://antseed.com/og-image.jpg'},
      {property: 'og:image', content: 'https://antseed.com/og-image.jpg'},
      {name: 'twitter:title', content: 'AntSeed — The open market for AI inference'},
      {name: 'twitter:description', content: 'Permissionless peer-to-peer AI inference. Pay per request in USDC. Anonymous by design, with independent providers and no central account.'},
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
        {to: '/network', label: 'Ecosystem', position: 'left'},
        {to: '/ants-token', label: '$ANTS', position: 'right', className: 'header-ants-link'},
        {
          type: 'docSidebar',
          sidebarId: 'docs',
          label: 'Docs',
          position: 'right',
          className: 'header-docs-link',
        },
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
          href: 'https://github.com/AntSeed/antseed/releases/latest',
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
