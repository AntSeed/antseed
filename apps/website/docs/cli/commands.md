---
sidebar_position: 1
slug: /commands
title: CLI Commands
sidebar_label: Commands
hide_title: true
---

# CLI Commands

### Getting started

```bash title="setup"
antseed init                          Initialize node + install plugins
antseed setup --role <provider|buyer> Check readiness and walk through setup
```

### Providing (selling)

```bash title="provider"
antseed seed --provider <name>        Start providing AI services
antseed register                      Register peer identity on-chain (ERC-8004)
antseed stake <amount>                Stake USDC as a provider (min $10)
antseed unstake                       Withdraw staked USDC
antseed claim                         Claim accumulated seller payouts
```

### Buying (consuming)

```bash title="buyer"
antseed connect --router <name>       Start the buyer proxy
antseed deposit <amount>              Deposit USDC for payments
antseed withdraw <amount>             Withdraw USDC from deposits
antseed balance                       Check wallet and deposit balance
antseed browse                        Browse available services and pricing
antseed payments                      Launch the payments portal
```

### Network and monitoring

```bash title="network"
antseed status                        Show node and network status
antseed config                        Manage config file
antseed peer <peerId>                 View a peer's profile
antseed profile                       Manage your peer profile
antseed plugin                        Manage plugins (add, remove, list)
antseed dashboard                     Launch the local web dashboard
antseed channels                      List payment channels
antseed emissions                     View epoch info and ANTS emissions
antseed bootstrap                     Run a dedicated DHT bootstrap node
antseed connection                    Manage connection settings
antseed dev                           Run seller + buyer locally for testing
```
