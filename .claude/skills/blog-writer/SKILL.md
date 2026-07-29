---
name: blog-writer
description: Write a post for the AntSeed blog from an entry in content/blog-queue.yml. Use when the weekly blog workflow runs, or when someone asks to draft, write, or revise an AntSeed blog post. Covers voice, SEO requirements, frontmatter format, internal linking, and the checks a post must pass before it opens a PR.
---

# AntSeed Blog Writer

Write one post. Make it good enough that a reader who has never heard of AntSeed
would still bookmark it.

The failure mode this skill exists to prevent is competent, forgettable filler:
correct facts, neutral tone, nothing anyone would ever link to. Sections
"Research first" and "Voice" are the whole point. Do not skip them.

---

## Company context (fixed)

AntSeed is a peer-to-peer AI services network. Providers offer inference, agents,
routers, or TEE-backed environments. Buyers run a local proxy at `localhost:8377`
that discovers providers over a BitTorrent DHT, scores them, and routes requests
over encrypted WebRTC connections. No accounts, no signup, no central gatekeeper.
The API surface is OpenAI and Anthropic compatible, so a base URL swap is usually
the entire integration.

Audience: English-speaking developers and technical builders. They have shipped
things. They can smell a pitch.

**Framing rule, non-negotiable.** Payments settle in USDC on Base. That is plumbing,
not the pitch. Never lead with it. Never mention tokens, tickers, or price. Never
frame AntSeed as a crypto project. The story is always cost, access, independence
from a single provider, and open models. If an angle only works as a crypto angle,
find a different angle.

**Compliance boundary.** AntSeed is for providers building differentiated services.
Raw resale of API keys or subscription credentials is not permitted and violates
upstream terms. Never write anything that reads as encouragement to resell a Claude
Pro or Team subscription. If a post touches provider economics, state the boundary.

---

## Step 0: Load context

Every run, before writing a word.

1. Read the queue entry you were given in `content/blog-queue.yml`. All of it.
2. `ls apps/website/blog/` and read the frontmatter of the three most recent posts.
3. Read every post listed in the entry's `must_link`, or at least its opening and
   its headings. You are going to link to it, so know what it says.
4. Grep the blog directory for the entry's `primary_keyword`. If an existing post
   already targets it, stop and say so in the PR description instead of shipping
   a duplicate. Two pages fighting for one keyword is worse than one page.

---

## Step 1: Research first

Do not write from memory. Model knowledge on pricing, rate limits, model names,
and protocol status goes stale in weeks, and this space moves faster than most.

- Web search the primary keyword. Read the top three results properly. You are
  looking for what they all say, so you can say something else.
- Verify every number you plan to publish against a primary source. Provider
  pricing pages, official docs, the repo itself, `PRICING.md`,
  `https://network.antseed.com/stats`.
- For anything about AntSeed's own behaviour, read the code or the docs. Do not
  guess at a CLI flag. Run `grep` and find it.
- If a claim cannot be verified, cut it. Do not hedge it into the post.

Date-sensitive facts get a visible "Verified [Month Year]" note near the claim.

---

## Step 2: Structure

Non-negotiable structure rules, in severity order.

**Answer the query in the first 100 words.** No preamble, no brand throat clearing.
State the direct answer or the core claim, then elaborate below. Google pulls the
opening for snippets and so do AI search engines.

**Primary keyword appears in the first paragraph and in at least one H2.** Natural
placement, once or twice. Keyword stuffing reads as spam to both humans and crawlers.

**No H1 in the body.** Docusaurus renders the frontmatter title as the H1. Start
the body at H2.

**`<!-- truncate -->` after the intro.** Two to four paragraphs in. This is the
blog list excerpt, so it must stand alone and make someone click.

**Self-contained paragraphs of 40 to 80 words.** AI search cites passages, not pages.
Each paragraph should survive being quoted on its own.

**Definition then elaboration.** For every key concept: one crisp sentence defining
it, then the detail. "[Term] is [definition]. [Elaboration]."

**Structured data as structure.** Comparisons go in tables. Processes go in
numbered lists. Features go in bullets. Never bury a comparison in prose.

**Questions as headings.** Where a real question exists, make it an H2 or H3 and
answer it in 40 to 60 words directly underneath. That is the shape a featured
snippet takes.

**Minimum two internal links**, using the entry's `must_link` list, with descriptive
anchor text. Never "click here" or "read more". The anchor should describe the
destination.

**At least one outbound link to a primary source.** Trust signal, and it keeps you
honest.

---

## Step 3: Voice

Short sentences next to long ones. Break the rhythm on purpose.

- No em dashes. Use `--` if you need a break, or restructure the sentence. This is
  a house rule, follow it.
- Banned openers: "In today's world", "In the fast-paced world of", "As we all know".
- Banned adjectives: game-changing, revolutionary, seamless, cutting-edge, robust,
  powerful (as a standalone claim).
- No "In conclusion". End on a thought, not a label.
- First person plural is fine and encouraged. We built this, we got this wrong once,
  we think this.
- Say the uncomfortable thing. Where AntSeed is the wrong tool, write that sentence.
  A comparison post that finds no case for the competitor is not a comparison post,
  it is an ad, and readers can tell instantly.
- Concrete over abstract. "A 70B model needs about 40GB of VRAM at 4-bit" beats
  "significant hardware requirements".

The strongest post shape found so far: state the thing everyone believes, then show
where it stops being true. Reach for it when the topic allows.

---

## Step 4: Frontmatter

Exact format. Copy this, fill it in.

```yaml
---
slug: <slug from the queue entry, unchanged>
title: "<50 to 60 characters, primary keyword near the front>"
authors: [antseed]
tags: [<4 to 7 tags, reuse existing tags from other posts where they fit>]
description: <120 to 155 characters, written to earn a click, keyword included>
keywords: [<primary keyword, then 4 to 6 secondaries from the queue entry>]
image: /og-image.jpg
date: <YYYY-MM-DD, today>
---
```

Filename: `apps/website/blog/YYYY-MM-DD-<slug>.md`

Character counts are hard limits, not suggestions. Count them. A 170 character
description gets truncated in results and wastes the click.

---

## Step 5: Self-check before opening the PR

Run `node scripts/blog-lint.mjs apps/website/blog/<filename>` and fix everything
it flags. If it passes, read the post once more and ask three questions:

1. Would I send this to a developer I respect? If not, what is the boring part?
2. Is there one sentence in here that no competitor would write? If not, add it.
3. Did I make a claim I did not verify? Cut it or verify it.

Then update the queue entry's `status` from `queued` to `drafted`.

---

## Step 6: Open the PR

Branch: `blog/<slug>`

PR title: `blog: <title>`

PR body, in this order:

- **Target keyword** and why this angle over the obvious one.
- **Sources verified**, as a list of URLs, with any number you published and where
  it came from.
- **Internal links added**, and any existing post that now deserves a link back to
  this one. List those as a suggested follow-up, do not edit other posts yourself.
- **Uncertain**, a short list of anything a human should check before merging.
  If this section is empty you probably did not look hard enough.

Never merge. Never push to `main`. A human reads it first.
