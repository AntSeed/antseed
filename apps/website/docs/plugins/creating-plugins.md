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

Use the templates in the protocol repository as a starting point, or configure a provider entry with `antseed seller setup` / `antseed config seller add-provider` and point it at your package.

## Naming Convention

Provider plugins: `@antseed/provider-*`. Router plugins: `@antseed/router-*`. Publish to npm and install via `antseed config seller add-provider <name> --plugin <package>` or `antseed seller setup`.

## Verification

Each template includes a `npm run verify` script that validates your plugin implements the required interface before publishing.
