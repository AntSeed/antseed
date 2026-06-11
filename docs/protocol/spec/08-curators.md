# 08 - Peer Curation: Curators and Lists

AntSeed's network is open: anyone can announce a service and become a peer, so the
peer list a buyer sees can grow large and noisy. Peer curation tames that, letting
a buyer narrow the open set down to a subset that third parties it trusts have
vouched for.

A *curator* publishes one or more *lists* of peers it vouches for. The buyer adds
curators it trusts, the client downloads their lists, and any peer on a list gets
a checkmark.

Curation is display-only: it's a badge a human reads, and never feeds peer
selection, scoring, routing, metering, or payments. A vouch is just as plain: a
peer is in a list or not, with no per-peer claim, level, or reason. Any meaning
lives in the list: its name, and the curator behind it.

That minimalism is the point. A bare vouch and a publish-anywhere manifest let
many kinds of list grow on top, with no new protocol surface.

Who keeps a list is open:

- An individual's personal list of peers they trust.
- A company's list of partners it has vetted.
- A community list maintained together, say a JSON file in a public Git repo,
  where the pull requests and edit history are the trust signal.
- A bot-generated list, say one ranking peers by on-chain signals like
  settlement volume or stake age, republished as the chain changes.

What a list *means* is open too, carried by its name and contents rather than any
field in the file:

- A general "peers we trust" list.
- Only companies the curator has KYB-verified.
- Only providers whose TEE attestation someone checked.

The protocol defines none of these. A curator just publishes a separate, clearly
named list, and the buyer reads its meaning from the curator and the list's name.

## 1. Scope

This specification defines:

- The curator manifest: the document a curator publishes describing itself and its
  lists, and where it is served.
- How a buyer client adds, stores, fetches, and refreshes curators.
- How a client matches a peer against subscribed curators and shows the curated
  badge and the "curated only" filter.
- The trust and security properties of the feature.

## 2. Participants

| Participant | Responsibility |
|---|---|
| Curator | A third party that publishes a manifest (Section 6) as a JSON file at a URL it shares, describing one or more lists of the peers it vouches for. Trusted only by the URL the buyer adds, and only by buyers that explicitly add it. |
| Buyer client | The AntSeed Desktop app or CLI. Stores the buyer's curators, fetches each curator's manifest, matches peers locally, and renders the curated badge and filter. |
| Peer | Any node that appears in the buyer's peer list, identified by its PeerId. A peer takes no part in curation: it does not opt in, publish, or learn that it was listed. |

## 3. Data Conventions

Unless otherwise stated, this document uses the conventions in
[00-conventions.md](./00-conventions.md). A peer is named by its **PeerId**, the
canonical EVM address defined there, which the buyer already holds for every peer
(`PeerInfo.peerId`).

## 4. Trust Model

| Rule | Why it holds |
|---|---|
| Display-only. | A vouch never affects selection, scoring, routing, metering, or payments. |
| Buyer controls the list. | A curator affects nothing unless the buyer adds it, and the buyer can remove it anytime. |
| Trust is the URL. | The buyer trusts the file at the URL it added; `name`, `icon`, and list names are display text, never trust inputs. |
| Vouches are bare and positive. | A listing only ever says "this list vouches for this peer," so a curator may list any address without consent. |
| The PeerId is a key. | It is the peer's EVM address, so a vouch can only name the real key holder; no impersonation to defend. |

The only real defense is the buyer's choice of curator: one that vouches for bad
peers spends its own reputation and gets removed. A positive vouch over a key
needs no consent or signatures.

## 5. The Curation Flow

```text
USER                BUYER CLIENT                   CURATOR SITE
 | add manifest URL    |                                |
 |-------------------->| store URL                      |
 |                     | GET manifest ----------------->|
 |                     |<----------------------------- manifest (lists)
 |                     | cache manifest                 |
 |                     |                                |
 | browse peers        |                                |
 |-------------------->| match each peerId vs. lists in  |
 |                     | cached manifests, locally      |
 |<--------------------| render checkmark + attribution |
 |                     |                                |
 |  (launch / hourly)  | refetch manifests ------------>|
```

The user adds a curator by pasting its manifest URL; everything after happens
locally. The client caches each manifest (Section 8) and, when the user browses,
matches PeerIds against the cached lists to render checkmarks (Section 9).

## 6. The Curator Manifest

A curator publishes its manifest as a JSON file at any HTTPS URL it shares, on its
own site or any host that can serve a file (a gist, object storage). The buyer
pastes that URL directly:

```text
GET https://curator.example/lists/trusted.json
```

```json
{
  "version": 1,
  "kind": "antseed.curator.manifest",
  "name": "Acme Curated",
  "homepage": "https://curator.example",
  "icon": "https://curator.example/icon.png",
  "lists": [
    {
      "id": "trusted-providers",
      "name": "Trusted Providers",
      "peers": [
        "abcabcabcabcabcabcabcabcabcabcabcabcabca",
        "def0def0def0def0def0def0def0def0def0def0"
      ]
    },
    {
      "id": "audited-tee",
      "name": "Audited TEE",
      "peers": [
        "1234123412341234123412341234123412341234"
      ]
    }
  ]
}
```

| Field | Requirement |
|---|---|
| `version` | Manifest version. MUST be `1`. |
| `kind` | MUST be `antseed.curator.manifest`. |
| `name` | Display name of the curator, shown to the user. Display-only and untrusted. |
| `homepage` | Optional. Curator homepage, HTTPS in production. Display-only. |
| `icon` | Optional. Curator icon URL, HTTPS in production. Display-only. |
| `lists` | Array of lists (below). MAY be empty. |

Each entry of `lists` is an object:

| Field | Requirement |
|---|---|
| `id` | Stable identifier for the list, unique within the manifest. Clients MAY use it to track a list across refetches. |
| `name` | Display name of the list, shown to the user. Display-only and untrusted. |
| `peers` | Array of canonical PeerIds the list vouches for. MAY be empty. |

The manifest carries no security input: there is no registry of curators and no
signature. The buyer trusts the file only because it chose its URL (Section 4).

## 7. Adding and Storing Curators

To add a curator, the user pastes the manifest URL. The client fetches it,
validates the manifest (Section 6), and stores the URL as the curator's identity.
The buyer can remove a curator at any time.

URL rules:

- A production URL MUST use `https://`; local development MAY use
  `http://localhost` (or `127.0.0.1` / `[::1]`).
- The client stores and shows the exact URL so the buyer can confirm what it
  trusts. A look-alike or attacker-controlled URL is the user's risk; showing the
  exact URL is the only mitigation.
- The client MUST de-duplicate by URL, so adding the same URL twice does nothing
  extra.

## 8. Fetching and Caching

The client fetches each curator's manifest on launch and periodically thereafter
(about hourly), plus on an explicit refresh if it offers one. It caches the last
manifest it fetched successfully; on a failed fetch it keeps the cached one and
SHOULD mark that curator stale. A curator with no successful fetch yet contributes
no vouches.

A vouch is reflected only on the next successful refetch, so **revocation latency
is one refresh cycle**: a curator drops a PeerId from a list, and the checkmark
disappears after the next fetch.

## 9. Matching, the Badge, and the Filter

The client matches locally. A peer is **curated** when its PeerId appears in the
`peers` of at least one list of at least one subscribed curator, including a
manifest currently marked stale.

- The client marks every curated peer in the peer list with a checkmark. The mark
  need not literally be a checkmark; any clear visual indicator works, and this
  spec calls it the checkmark for short.
- The client SHOULD show, in the peer's detail view, which curators and lists
  vouch for it, naming each curator by its manifest URL and `name` and each list
  by its `name`.
- The client SHOULD offer a **"curated only" filter**: a UI toggle that hides
  uncurated peers from the displayed list. The filter is a view over the list the
  user is already looking at; it MUST NOT change which peers the router discovers,
  scores, or selects.

Matching never contacts the peer or the curator: it is a set membership test
against already-fetched manifests, so a curator never learns which peers the buyer
cares about. Curation adds no field to `PeerInfo`, the discovery metadata, or the
DHT.

## 10. Relationship to Reputation

Curation and reputation are complementary. Reputation
([05-reputation.md](./05-reputation.md)) ranks every peer mechanically from earned
signals (on-chain settlement volume, stake age, ghost rate, runtime metrics) and
feeds router selection. Curation hand-picks a subset a human opts into, and feeds
nothing automatic.

The two compose: a curator can build a list *from* reputation signals, say a bot
that lists peers above some settlement volume or stake age, so reputation is one
of the primitives a list can be generated from. The resulting list is still a
display badge, off-chain and unsigned. A curator that wants its endorsements to
carry machine-usable, on-chain weight should use reputation and attestation
directly instead.

## 11. Versioning

This specification defines version `1` manifests. Clients MUST reject a manifest
with an unknown `version` and MAY ignore unknown fields. Any future change to what
a vouch means goes under a new `version`.
