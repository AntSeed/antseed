import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'AntSeed',
  tagline: 'Private AI. Anonymous. Peer-to-peer.',
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
  ],

  themeConfig: {
    metadata: [
      {name: 'google-site-verification', content: '09pzs5Q9kHdpQSNSBpr0vNh9SMq-T8lzhBgH5Zgm6ug'},
      {name: 'keywords', content: 'private AI, anonymous AI, P2P AI, decentralized AI inference, uncensored AI, AI without account, no signup AI, peer-to-peer AI'},
      {name: 'description', content: 'Private AI inference with zero data collection. No account, no logs, no middleman. Connect directly to AI providers through an anonymous P2P network.'},
      {property: 'og:title', content: 'AntSeed — Private AI. Anonymous. Peer-to-peer.'},
      {property: 'og:description', content: 'Private AI inference with zero data collection. No account, no logs, no middleman.'},
      {property: 'og:type', content: 'website'},
      {name: 'twitter:card', content: 'summary_large_image'},
      {name: 'twitter:title', content: 'AntSeed — Private AI. Anonymous. Peer-to-peer.'},
      {name: 'twitter:description', content: 'Private AI inference with zero data collection. No account, no logs, no middleman.'},
    ],
    colorMode: {
      defaultMode: 'dark',
      disableSwitch: true,
      respectPrefersColorScheme: false,
    },
    navbar: {
      items: [],
    },
    prism: {
      theme: prismThemes.dracula,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'json', 'typescript'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
