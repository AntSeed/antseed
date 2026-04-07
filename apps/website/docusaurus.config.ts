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
  tagline: 'The open market for AI inference. No gatekeepers.',
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
          blogDescription: 'Insights on OpenRouter alternatives, P2P AI networks, and the future of AI inference.',
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
          'The open market for AI inference. No gatekeepers. Serving or consuming AI inference peer-to-peer. Anonymous. Private. No gatekeepers.',
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
        softwareVersion: '0.1.49',
        license: 'https://github.com/AntSeed/antseed/blob/main/LICENSE',
      }),
    },
  ],

  themeConfig: {
    metadata: [
      {name: 'google-site-verification', content: '09pzs5Q9kHdpQSNSBpr0vNh9SMq-T8lzhBgH5Zgm6ug'},
      {name: 'keywords', content: 'AI marketplace, OpenRouter alternative, serving AI inference, consuming AI inference, peer-to-peer AI, decentralized AI inference, anonymous AI, private AI, P2P AI, AI economy'},
      {name: 'description', content: 'Serving or consuming AI inference peer-to-peer. Anonymous. Private. No gatekeepers.'},
      {property: 'og:title', content: 'The open market for AI inference. No gatekeepers.'},
      {property: 'og:description', content: 'Serving or consuming AI inference peer-to-peer. Anonymous. Private. No gatekeepers.'},
      {property: 'og:type', content: 'website'},
      {name: 'twitter:card', content: 'summary_large_image'},
      {name: 'twitter:image', content: 'https://antseed.com/og-image.jpg'},
      {property: 'og:image', content: 'https://antseed.com/og-image.jpg'},
      {name: 'twitter:title', content: 'The open market for AI inference. No gatekeepers.'},
      {name: 'twitter:description', content: 'Serving or consuming AI inference peer-to-peer. Anonymous. Private. No gatekeepers.'},
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
        {to: '/providers', label: 'Providers', position: 'right'},
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
