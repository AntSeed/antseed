---
slug: claude-code-pricing-breakeven
title: "Claude Code Pricing: When $17 Stops Being Cheap"
authors: [antseed]
tags: [pricing, Claude, cost, AI infrastructure, P2P, API pricing]
description: Claude Code pricing breaks even near 298 requests a month. Here is the math, from Anthropic's published rates and 14 million real agent requests.
keywords: [claude code pricing, claude code cost, claude code pro vs api, claude api pricing, claude opus 5 price, cost per request, prompt caching cost]
image: /og-image.jpg
date: 2026-08-11
---

Claude Code pricing comes in two shapes: a $17 per month Pro subscription, or per-token API billing where you pay for exactly what you use. The switchover point is sharper than most people expect. At Anthropic's published Opus 5 rates and a realistic agent workload, the subscription stops being the cheaper option at roughly **298 requests a month**. That is about ten a day.

Below that, pay the $17 and stop reading. Above it, the arithmetic starts to matter, and it matters in a direction most cost comparisons get backwards.

<!-- truncate -->

## How does Claude Code pricing work?

Claude Code is billed two ways. The Pro plan is $17 a month on an annual subscription and includes Claude Code alongside the chat product. The API route bills per million tokens, split into input and output, with a separate and much cheaper rate for cached input.

Here are the published API rates, taken from [Anthropic's pricing documentation](https://platform.claude.com/docs/en/about-claude/pricing). Verified August 2026.

| Model | Input / MTok | Output / MTok | Cache read / MTok |
|---|---|---|---|
| Claude Opus 5 | $5.00 | $25.00 | $0.50 |
| Claude Sonnet 5 (through Aug 31) | $2.00 | $10.00 | $0.20 |
| Claude Sonnet 5 (from Sep 1) | $3.00 | $15.00 | $0.30 |
| Claude Haiku 4.5 | $1.00 | $5.00 | $0.10 |
| Claude Fable 5 | $10.00 | $50.00 | $1.00 |

One pattern worth noticing before we go further: output is priced at exactly five times input on every single model. Opus, Sonnet, Haiku, Fable. That ratio never moves. Hold onto it, because it collides with something in the traffic data.

## The breakeven is 298 requests a month

To turn rates into a bill you need to know the shape of a real request, not a hypothetical one. We pulled ours from the [AntSeed network stats endpoint](https://network.antseed.com/stats), which reports live totals across the peers currently online.

As of 11 August 2026, that endpoint reports 13,984,528 requests carrying 88.96 billion input tokens and 14.07 billion output tokens. The average request is **6,361 input tokens and 1,006 output tokens**.

One honest caveat: those totals cover all traffic on the network, not Claude Code specifically. Agent-shaped workloads dominate it, but treat the ratio as a good proxy rather than a measurement of Claude Code itself.

Run that shape through the published rates and you get cost per request:

| Model | Cost per average request | Requests to reach $17 |
|---|---|---|
| Claude Opus 5 | $0.0570 | 298 |
| Claude Sonnet 5 (intro) | $0.0228 | 746 |
| Claude Haiku 4.5 | $0.0114 | 1,491 |
| Claude Fable 5 | $0.1139 | 149 |

If you run Opus 5 for real work, ten requests a day puts you at the subscription price. A working session with a coding agent can burn that before lunch.

![Line chart of Claude Code pricing: the flat $17 per month Pro subscription against per-token API cost, crossing at 298 requests per month without caching and at 545 requests with a 90% cache hit rate](/img/blog/claude-code-pricing-breakeven.svg)

The chart is the whole argument. The flat line is what you pay Anthropic today. The steep line is what you pay per token. Where they cross is the only number in this post that matters, and caching moves it a long way to the right.

## Why input tokens are 56% of your bill

Here is the collision. Output costs five times what input costs. But real agent traffic sends **6.32 input tokens for every output token**, because coding agents re-send the file, the diff, the tool schemas, and the whole conversation on every turn.

Six point three two against a five times price multiple means input wins. At the observed traffic shape, **input is 56% of the bill and output is 44%** -- and because both ratios are fixed, that split is identical for every model in the table above.

This is the part most Claude Code pricing comparisons get backwards. They benchmark on the output number, because it is the big scary one. The larger line item is the number nobody quotes.

### Does that change which model I should pick?

Not directly, since the split is the same everywhere. What it changes is where you spend optimization effort. Trimming what you send Claude, and caching what you must re-send, moves more money than switching to a model with a cheaper output rate.

## Does prompt caching change the answer?

Yes, substantially. Anthropic charges cache reads at 0.1x the base input rate, a flat ten times discount. Cache writes cost 1.25x for the five-minute window or 2x for the one-hour window, so caching pays for itself after a single read on the short window.

Apply a 90% cache hit rate to an Opus 5 workload and cost per request falls from $0.0570 to $0.0312. The breakeven moves from 298 requests a month to **545**. Caching is the single biggest lever available before you change anything about where your requests go.

We will say the uncomfortable part plainly: on a cache-heavy workload under about 500 requests a month, the $17 subscription is the right answer and no marketplace is going to beat it. Buy the subscription.

## What an open market charges for the same models

Above that line, the question changes from "subscription or API" to "whose API". This is where an open market of independent providers gets interesting, and where the numbers stop being flattering in one direction only.

The table below compares Anthropic's list input price against what providers on the AntSeed network were actually charging on 11 August 2026.

| Model | Providers | Official | Market median | Market low | Below list |
|---|---|---|---|---|---|
| claude-opus-5 | 9 | $5.00 | $3.00 | $0.28 | 8 of 9 |
| claude-opus-4-8 | 14 | $5.00 | $1.92 | $0.99 | 9 of 14 |
| claude-fable-5 | 13 | $10.00 | $4.95 | $1.70 | 11 of 13 |
| claude-haiku-4-5 | 5 | $1.00 | $0.35 | $0.07 | 4 of 5 |
| claude-sonnet-5 | 9 | $2.00 | **$2.09** | $0.12 | 4 of 9 |

Read the last row before the other four. Sonnet 5's market median sits *above* Anthropic's list price, and only four of nine providers beat it. That is not a bug in the market, it is a lag: Anthropic cut Sonnet 5 to $2 as introductory pricing through 31 August, and independent providers have not repriced against a temporary discount that expires in three weeks.

Caching tells a similar story. Of 201 Claude-family services quoting prices on the network, 162 publish a cached input rate, at a median discount of 7.7x. Anthropic's flat 10x is better. If your workload lives in the cache, first-party pricing is genuinely competitive and we are not going to pretend otherwise.

Where the market does win is the base input rate, which is the 56% of your bill we established earlier. A median of $3.00 against a list price of $5.00 on Opus 5 is a 40% cut on the largest line item.

## When you should just pay the $17

A short list, because a pricing post that finds no case for the incumbent is an advert.

- **Under ten Opus requests a day.** The subscription is cheaper and there is nothing to manage.
- **Cache-heavy workloads under roughly 500 requests a month.** Anthropic's 10x cache discount beats the market median.
- **You need first-party support, an SLA, or a procurement relationship.** An open network of independent providers does not offer any of those.
- **Your finance team wants one predictable line item.** Per-request billing is cheaper and less legible. That trade is real.

One boundary worth stating clearly, since it comes up whenever provider economics do: providers on an open network are expected to offer differentiated services on their own infrastructure. Reselling subscription credentials violates upstream terms and is not something the network is for.

## How to check your own numbers

Do not take our request shape. Take yours.

1. Pull your actual token counts from the `usage` block Anthropic returns on every response. You want `input_tokens`, `output_tokens`, and `cache_read_input_tokens` separately.
2. Compute your own input-to-output ratio. If it is far below 6.32:1 you are doing something unusual and the output rate matters more for you than it does for most.
3. Multiply by the published rates in the first table. That is your monthly bill at first-party pricing.
4. Compare against live market rates with `curl -s https://network.antseed.com/stats`, or the [AntSeed pricing schema documentation](/docs/pricing) if you want the field definitions.

If you decide the numbers justify moving, [pointing Claude Code at a different backend](/integrations/claude-code) is a base URL change and takes about two minutes. If you want the broader argument for why routing through an open market beats routing through one company's gateway, we made it in our [comparison against OpenRouter](/vs/openrouter).

The number to remember is 298. Everything above that is arithmetic you should run on your own traffic, not ours.
