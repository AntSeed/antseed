import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docs: [
    {
      type: 'category',
      label: 'Getting Started',
      collapsible: false,
      items: [
        'getting-started/intro',
        'getting-started/install',
        'getting-started/configuration',
      ],
    },
    {
      type: 'category',
      label: 'Guides',
      collapsible: false,
      items: [
        'guides/using-the-api',
        'guides/become-a-provider',
        'guides/payments',
      ],
    },
    {
      type: 'category',
      label: 'Protocol',
      collapsible: false,
      items: [
        'protocol/overview',
        'protocol/discovery',
        'protocol/transport',
        'protocol/metering',
        'protocol/payments',
        'protocol/reputation',
        'protocol/security',
      ],
    },
    {
      type: 'category',
      label: 'Plugins',
      collapsible: false,
      items: [
        'plugins/provider-plugin',
        'plugins/router-plugin',
        'plugins/creating-plugins',
      ],
    },
    {
      type: 'category',
      label: 'CLI Reference',
      collapsible: false,
      items: [
        'cli/commands',
        'cli/flags',
      ],
    },
    {
      type: 'category',
      label: 'Papers',
      collapsible: false,
      items: [
        'lightpaper',
      ],
    },
  ],
};

export default sidebars;
