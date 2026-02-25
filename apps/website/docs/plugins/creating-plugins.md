---
sidebar_position: 3
slug: /create-plugin
title: Creating Plugins
sidebar_label: Creating plugins
hide_title: true
---

# Creating Plugins

Plugins are npm packages that export a provider or router object. Use the templates in the protocol repository as a starting point.

## From the CLI

```bash title="scaffold"
# Interactive scaffold — creates a ready-to-build project
$ antseed plugin create
Plugin name: my-provider
Plugin type (provider/router): provider
Display name: My Provider
Description: Custom provider plugin

# Then build and test
$ cd antseed-provider-my-provider && npm install && npm test
```

## Naming Convention

Provider plugins: `@antseed/provider-*`. Router plugins: `@antseed/router-*`. Publish to npm and install with `antseed plugin add <package>`.

## Verification

Each template includes a `npm run verify` script that validates your plugin implements the required interface before publishing.
