import {themes as prismThemes} from 'prism-react-renderer';
import type {Config, Plugin, PluginModule} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

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
  tagline: 'The Unstoppable AI Economy',
  favicon: 'logo.svg',
  url: 'https://antseed.com',
  baseUrl: '/',
  onBrokenLinks: 'throw',

  scripts: [{src: '/force-light.js', async: false}],



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
      href: 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&family=Space+Grotesk:wght@300;400;500;600;700;800&display=swap',
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
          blogDescription: 'Insights on private AI, decentralized inference, and P2P AI networks.',
          postsPerPage: 10,
          blogSidebarCount: 'ALL',
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
        ],
      },
    ],
    statsProxyPlugin,
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
          'A peer-to-peer AI services network. Buy or sell AI inference directly — no platform middleman, no vendor lock-in. OpenAI-compatible API, reputation-based routing, TEE attestation.',
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
          'Per-service middleware and prompt injection',
          'Desktop app (AntStation)',
          'Agent-to-agent commerce support',
        ],
        downloadUrl: 'https://github.com/AntSeed/antseed/releases',
        softwareVersion: '0.1.25',
        license: 'https://github.com/AntSeed/antseed/blob/main/LICENSE',
      }),
    },
  ],

  themeConfig: {
    metadata: [
      {name: 'google-site-verification', content: '09pzs5Q9kHdpQSNSBpr0vNh9SMq-T8lzhBgH5Zgm6ug'},
      {name: 'keywords', content: 'AI marketplace, buy AI services, sell AI services, peer-to-peer AI, decentralized AI inference, anonymous AI, private AI, P2P AI, AI economy'},
      {name: 'description', content: 'Buy, sell, and build AI services peer-to-peer. Anonymous. Private. No middleman. Network live.'},
      {property: 'og:title', content: 'AntSeed — The Unstoppable AI Economy'},
      {property: 'og:description', content: 'Buy, sell, and build AI services peer-to-peer. Anonymous. Private. No middleman. Network live.'},
      {property: 'og:type', content: 'website'},
      {name: 'twitter:card', content: 'summary_large_image'},
      {name: 'twitter:image', content: 'https://antseed.com/og-image.jpg'},
      {property: 'og:image', content: 'https://antseed.com/og-image.jpg'},
      {name: 'twitter:title', content: 'AntSeed — The Unstoppable AI Economy'},
      {name: 'twitter:description', content: 'Buy, sell, and build AI services peer-to-peer. Anonymous. Private. No middleman. Network live.'},
    ],
    colorMode: {
      defaultMode: 'light',
      disableSwitch: true,
      respectPrefersColorScheme: false,
    },
    navbar: {
      title: 'ANTSEED',
      logo: {
        alt: 'AntSeed',
        src: 'logo.svg',
      },
      items: [
        {to: '/blog', label: 'Blog', position: 'right'},
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
