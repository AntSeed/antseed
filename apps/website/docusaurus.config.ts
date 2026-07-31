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

  stylesheets: [
    {
      href: 'https://fonts.googleapis.com/css2?family=Oxanium:wght@300;400;500;600;700;800&family=Share+Tech+Mono&display=swap',
      type: 'text/css',
    },
  ],

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
      {name: 'description', content: 'AntSeed is an open marketplace where providers compete on price to run any AI model. Use it anonymously, no account, in the AI tools you already use.'},
      {property: 'og:title', content: 'Every AI model, best price, no middleman'},
      {property: 'og:description', content: 'AntSeed is an open marketplace where providers compete on price to run any AI model. Use it anonymously, no account, in the AI tools you already use.'},
      {property: 'og:type', content: 'website'},
      {property: 'og:url', content: 'https://antseed.com/'},
      {property: 'og:site_name', content: 'AntSeed'},
      {name: 'twitter:card', content: 'summary_large_image'},
      {name: 'twitter:site', content: '@antseedai'},
      {name: 'twitter:image', content: 'https://antseed.com/og-image.png'},
      {property: 'og:image', content: 'https://antseed.com/og-image.png'},
      {property: 'og:image:width', content: '1200'},
      {property: 'og:image:height', content: '630'},
      {property: 'og:image:alt', content: 'AntSeed, the open market for AI inference'},
      {name: 'twitter:title', content: 'Every AI model, best price, no middleman'},
      {name: 'twitter:description', content: 'AntSeed is an open marketplace where providers compete on price to run any AI model. Use it anonymously, no account, in the AI tools you already use.'},
    ],
    colorMode: {
      defaultMode: 'dark',
      disableSwitch: false,
      respectPrefersColorScheme: false,
    },
    navbar: {
      title: 'ANTSEED',
      logo: {
        alt: 'AntSeed',
        src: 'logo-light.svg',
        srcDark: 'logo.svg',
      },
      items: [
        {
          href: 'https://antseedstats.com/network',
          label: 'Pricing',
          position: 'right',
          target: '_blank',
          rel: 'noopener noreferrer',
        },
        {to: '/integrations', label: 'Integrations', position: 'right'},
        {to: '/providers', label: 'Providers', position: 'right'},
        {
          type: 'docSidebar',
          sidebarId: 'docs',
          label: 'Docs',
          position: 'right',
          className: 'header-docs-link',
        },
        {to: '/blog', label: 'Blog', position: 'right'},
        {to: '/ants-token', label: '$ANTS', position: 'right', className: 'header-ants-link'},
        {
          href: process.env.NODE_ENV === 'development' ? 'http://localhost:5180/' : 'https://diemantseed.com',
          label: '$DIEM',
          position: 'right',
          className: 'header-diem-link',
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

      ],
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'json', 'typescript'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
