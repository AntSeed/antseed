import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docs: [
    {
      type: 'doc',
      id: 'lightpaper',
      label: 'Light Paper',
    },
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
      label: 'Protocol',
      collapsible: false,
      items: [
        'protocol/overview',
        'protocol/discovery',
        'protocol/transport',
        'protocol/metering',
        'protocol/payments',
        'protocol/reputation',
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
  ],
};

export default sidebars;
