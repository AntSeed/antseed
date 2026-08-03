# Analytics setup

Google Tag Manager is wired into the site. GA4 runs **inside** GTM rather than as a
second script, so there is one tag on the page, no risk of double-counted
pageviews, and future pixels (Ads, LinkedIn, Meta) are a GTM change rather than a
code change and redeploy.

Everything in code is done. What follows are the steps that need a Google account
and cannot be done from the repo.

---

## What the site already does

| Piece | Where |
|---|---|
| GTM container snippet | `docusaurus.config.ts` → `@docusaurus/plugin-google-tag-manager` |
| Event helpers | `src/lib/analytics.ts` |
| Global click tracking | `src/theme/Root.tsx` |
| Search Console verification tag | `docusaurus.config.ts` → `themeConfig.metadata` |

Click tracking is delegated from `document`, so **every current and future link is
covered without touching any button**. The listener only reads; it can never block
or alter navigation.

### Events emitted

**`download_vpr`** — any click on a link to our GitHub releases. This is the
conversion event.

| Parameter | Example | Notes |
|---|---|---|
| `link_url` | `.../AntSeed-VPR-Setup-0.2.0.exe` | the resolved asset URL |
| `platform` | `win` | derived from the asset extension: `mac`, `win`, `linux`, or `releases_page` when the user hit the generic releases link |
| `link_text` | `Get Started` | the label actually rendered (the button carries both a desktop and a mobile label; only the visible one is recorded) |
| `link_section` | `The Open Market for AI Inference` | heading of the nearest section, so the hero CTA is distinguishable from the footer one |
| `page_path` | `/` | |

**`outbound_click`** — any click on a link leaving antseed.com.

| Parameter | Example |
|---|---|
| `link_url` | `https://antseedstats.com/network` |
| `outbound_domain` | `antseedstats.com` |
| `link_text` | `Pricing` |
| `link_section`, `page_path` | as above |

---

## 1. Create the GA4 property

1. <https://analytics.google.com> → **Admin** (bottom left)
2. **Create** → **Property**. Name it `AntSeed`, set timezone and currency.
3. Business details → **Create**.
4. Under **Data streams** → **Add stream** → **Web**.
   - URL `https://antseed.com`, name `AntSeed website`.
5. Copy the **Measurement ID** — looks like `G-XXXXXXXXXX`.

Leave *Enhanced measurement* on. It gives scroll depth, site search and outbound
clicks for free. Our own `outbound_click` is richer (it adds section and label),
so expect both; use ours in reports.

## 2. Create the GTM container

1. <https://tagmanager.google.com> → **Create Account**
   - Account name `AntSeed`, country as appropriate.
   - Container name `antseed.com`, target platform **Web**.
2. Copy the **Container ID** — looks like `GTM-XXXXXXX`.

## 3. Put the container ID into the build

The site reads `GTM_CONTAINER_ID` at build time. Set it as an environment
variable wherever the site is deployed (Vercel/Netlify/Cloudflare project
settings → Environment Variables), then redeploy.

```bash
GTM_CONTAINER_ID=GTM-XXXXXXX
```

If the variable is unset the plugin is skipped and no GTM script is emitted —
local builds and previews keep working, and the site never ships a broken tag.

Verify after deploy:

```bash
curl -s https://antseed.com | grep -o 'googletagmanager.com/gtm.js'
```

## 4. Configure GA4 inside GTM

In the GTM container:

**a. Base GA4 tag**
- **Tags** → **New** → *Google Tag*
- Tag ID: your `G-XXXXXXXXXX`
- Trigger: **Initialization — All Pages**

**b. Triggers for our events**
- **Triggers** → **New** → *Custom Event*
  - Name `download_vpr`, Event name `download_vpr`
- Repeat for `outbound_click`

**c. dataLayer variables**

**Variables** → **New** → *Data Layer Variable*, one per parameter you want in
reports. Name each the same as its dataLayer key:

`link_url`, `link_text`, `link_section`, `platform`, `outbound_domain`, `page_path`

**d. GA4 event tags**
- **Tags** → **New** → *Google Analytics: GA4 Event*
  - Configuration tag: the Google Tag from (a)
  - Event name `download_vpr`
  - Event parameters: `platform`, `link_section`, `link_text`, `link_url` → the
    matching variables from (c)
  - Trigger: the `download_vpr` trigger
- Repeat for `outbound_click` with `outbound_domain`, `link_text`, `link_section`

**e. Publish** — GTM changes are not live until you hit **Submit**.

## 5. Mark the conversion in GA4

1. GA4 → **Admin** → **Events**. `download_vpr` appears here **after the first
   one is recorded** — trigger one yourself first.
2. Toggle **Mark as key event** on `download_vpr`.

   *("Key event" is what GA4 now calls a conversion.)*

3. **Admin** → **Custom definitions** → **Create custom dimension** for each
   parameter you want to segment by. Without this the values are collected but
   not reportable:

   | Dimension name | Scope | Event parameter |
   |---|---|---|
   | Platform | Event | `platform` |
   | Link section | Event | `link_section` |
   | Link text | Event | `link_text` |
   | Outbound domain | Event | `outbound_domain` |

   Custom dimensions only apply going forward, so do this early.

## 6. Search Console

The verification meta tag is **already in the site**
(`themeConfig.metadata` → `google-site-verification`), so verification should
pass without further code changes.

1. <https://search.google.com/search-console> → **Add property**
2. Choose **Domain** (`antseed.com`) if you can add a DNS TXT record — it covers
   every subdomain and protocol. Otherwise **URL prefix** (`https://antseed.com`),
   which the existing meta tag already satisfies.
3. Verify.
4. **Sitemaps** → submit `https://antseed.com/sitemap.xml` (Docusaurus generates
   this automatically).
5. **Settings** → **Associations** → link the GA4 property, so Search Console
   queries appear inside GA4.

If verification fails, the existing tag likely belongs to a different Google
account — check who owns it before replacing the value.

---

## Testing

**GTM Preview** — in GTM, click **Preview**, enter `https://antseed.com`. Click a
Download VPR button and confirm `download_vpr` appears in the Tag Assistant
timeline with the right parameters.

**GA4 DebugView** — GA4 → **Admin** → **DebugView**. With GTM Preview connected,
events show in real time.

**Locally**, without any GTM container:

```bash
GTM_CONTAINER_ID=GTM-TEST123 pnpm --filter website build
```

then open the built site and run in the console:

```js
window.dataLayer.filter(e => e.event && !e.event.startsWith('gtm.'))
```

Clicking a download button should append a `download_vpr` entry.

---

## Notes

- **Ad blockers** block GTM and GA4. Expect roughly 10–30% under-reporting on a
  developer audience — treat the numbers as trends, not absolute truth. GitHub's
  own release download counts are the ground truth for downloads.
- The events fire on **click**, not on completed download. A user who clicks and
  cancels still counts.
- Nothing here sets cookies beyond what GA4 sets itself. If you later need a
  consent banner for EU traffic, do it via GTM's consent mode rather than in code.
