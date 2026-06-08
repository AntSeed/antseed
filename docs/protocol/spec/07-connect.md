# 07 - AntSeed Connect: Sharing Account Info with Web Apps

AntSeed Connect lets a web app ask the user's AntSeed client for information. The
web app opens a link that names what it wants and where to send the result; the
AntSeed Desktop app or CLI shows the user who is asking and what, then returns the
information signed by the local AntSeed identity, only when the user approves.

Connect has exactly one capability: share signed account information on request.
It never exposes the AntSeed identity private key, configuration, or local payment
authorizations. It shares only the specific, user-approved values named by a
*scope*.

Connect is general: funding a deposit balance (Section 15) is one use of it, where
a gateway learns the user's address and then runs its own checkout. The same flow
serves any other application.

## 1. Scope

This specification defines:

- The information request flow: a web app opens a link requesting scopes; the
  client returns signed values to the web app after user consent.
- Scopes: the named values a user can approve sharing. This version defines
  `address`.
- The request link, the signed response, and how a web app verifies it.
- The web app manifest.
- The CLI command and the desktop deep link.
- One application (Section 15): funding an `AntseedDeposits` balance.

## 2. Participants

| Participant | Responsibility |
|---|---|
| Web app | A hosted app (typically in a browser) that requests information from the user's AntSeed client. Trusted only by its verified HTTPS origin. |
| AntSeed Desktop | Loads the local identity, handles the `antseed://connect` deep link, shows the consent prompt, signs after approval, and delivers the response to the redirect URL. |
| AntSeed CLI | Loads the local identity, accepts a request link as an argument, shows the consent prompt, signs after approval, and delivers the response to the redirect URL. |
| Local AntSeed identity | The secp256k1 key held by the client. It never leaves the device. Its EVM address is the shareable account address. |

## 3. Data Conventions

Unless otherwise stated, this document uses the conventions in
[00-conventions.md](./00-conventions.md).

### Signatures

Off-chain signatures use EIP-191 `personal_sign` over the exact UTF-8 bytes of
the message shown, with no added prefix or domain tag; the first line of the
message is its only domain separator and MUST be reproduced exactly.

Signature fields MUST be 65-byte secp256k1 ECDSA signatures encoded as lowercase
hexadecimal without a `0x` prefix, matching [00-conventions.md](./00-conventions.md).
Implementations MAY accept a leading `0x` but MUST normalize before storage or
comparison.

## 4. Trust Model

| Rule | Consequence |
|---|---|
| The AntSeed identity key stays local. | Web apps never receive private keys, bearer tokens, config contents, ReserveAuth, SpendingAuth, or local store contents. |
| Shared information is user-approved. | The client shows the requesting origin and the exact values before signing or delivering them. |
| The origin is the redirect URL. | A web app is trusted only by the verified HTTPS origin of its redirect URL; a manifest display name is untrusted. |

Any page can craft a request link, but the origin shown to the user, bound in the
signature, and used as the response destination is always the origin of the
redirect URL. A request can therefore only share the user's address with the
origin that receives it, and the client displays that origin before the user
approves.

## 5. The Information Request Flow

```text
USER                  WEB APP                    ANTSEED CLIENT
 | uses app             |                              |
 |--------------------->|                              |
 |                      | builds request link          |
 |<---------------------| opens link                   |
 |---------------------------------------------------->|
 |                      |                              | derive origin from redirect
 |                      |<- - - - - - - - - - - - - - -| GET manifest (optional)
 |                      |                              | show consent prompt
 | approves             |                              |
 |---------------------------------------------------->|
 |                      |<-----------------------------| deliver signed response to redirect
 |                      | verify signature             |
```

The web app builds a request link (Section 6) naming the scopes it wants, a
challenge, and a redirect URL, then opens it: as the `antseed://connect` deep link
on Desktop, or as a command argument for the CLI.

The client derives the requesting origin from the redirect URL, optionally fetches
the app's manifest (Section 10) to enrich the consent screen, shows the consent
prompt (Section 8), and on approval signs the response (Section 9) and delivers
it to the redirect URL.

No round-trip to the web app is needed before consent: the origin comes from the
redirect URL and the scopes come from the link. The manifest fetch is optional
enrichment.

## 6. The Request Link

A request link carries the request in its query string:

```text
antseed://connect?version=1&redirect=https%3A%2F%2Fapp.example%2Fconnect%2Fcb&scopes=address&challenge=base64url-random-challenge
```

| Param | Requirement |
|---|---|
| `version` | Protocol version. MUST be `1`. |
| `redirect` | URL-encoded redirect URL. The signed response is delivered here, and its origin is the requesting app's identity. |
| `scopes` | Comma-separated scope ids. MUST contain only supported scopes. This version defines only `address`. |
| `challenge` | Single-use random challenge from the web app, with at least 128 bits of entropy. |

The CLI accepts the same link, or its `https`-scheme equivalent carrying the same
query, as a command argument.

Redirect URL rules:

- Production redirect URLs MUST use `https://`. Local development MAY use
  `http://127.0.0.1`, `http://[::1]`, or `http://localhost`.
- The redirect URL MUST NOT contain a fragment (the response is delivered in the
  fragment) or a username or password (which can disguise the real origin).
- The client derives the requesting origin from the redirect URL using a standard
  URL parser (the WHATWG URL standard), so the origin is unambiguous and cannot be
  spoofed by parser differences. That origin is shown to the user, used to fetch
  the manifest, and bound in the signature.

The client MUST reject: an unknown `version`; a missing or invalid `redirect`; a
non-HTTPS redirect in production; unknown or duplicate scopes; or a missing
`challenge`.

## 7. Scopes

A scope is a named value the user can approve sharing, identified by a string id.
The web app lists the scopes it wants in the request link's `scopes` parameter
(Section 6); the client shares a value for each one the user approves.

Every response is signed by the local identity, so a web app can always recover
the account address from the signature, and every shared value is an attestation
by that identity. Because of this, any response reveals the account address even
when `address` is not among the requested scopes.

Values are UTF-8 strings in the signed message and JSON values in the response
`values` object (Section 9).

This version defines one scope:

| Scope | Value | Notes |
|---|---|---|
| `address` | The account's EVM address, lowercase and `0x`-prefixed. | Self-attesting: the value MUST equal the signer recovered from the response. |

To add a scope, assign an id and define its value's meaning and encoding. Clients
MUST reject a request containing an unknown scope; web apps MUST reject a response
containing a scope they did not request.

## 8. User Approval

Before signing, the client MUST show:

- The verified requesting origin (derived from the redirect URL).
- The app name, if a manifest was fetched.
- The requested scopes and the exact values that will be shared.

The verified origin is the security identity; a manifest `name` is display text
and MUST NOT be treated as trusted.

```text
App:     Example App
Origin:  https://app.example
Request: Share AntSeed account address
Address: 0x1234567890abcdef1234567890abcdef12345678

Approve? [y/N]
```

If the user declines, the client MUST NOT sign or deliver a response.

## 9. Signed Response

After approval, the client signs this exact UTF-8 EIP-191 message with the local
AntSeed identity:

```text
AntSeed Connect
version: 1
redirect: <redirect>
challenge: <challenge>
scopes: <comma-separated-scopes>
address: <address>
```

Rules:

- Line endings MUST be LF, with no trailing blank line.
- `redirect` MUST be the redirect URL from the request link.
- `scopes` MUST preserve the order from the request link.
- One value line follows `scopes` for each shared scope, in the same order.
  This version defines `address`; future scopes add their own lines.
- Address-valued scopes MUST be lowercase and `0x`-prefixed.
- The response MUST be signed by the local identity. For the `address` scope, its
  value MUST equal the recovered signer; other scopes are values that signer
  attests.

The signed response is:

```json
{
  "version": 1,
  "kind": "antseed.connect.response",
  "challenge": "base64url-random-challenge",
  "values": { "address": "0x1234567890abcdef1234567890abcdef12345678" },
  "signatureScheme": "eip191-personal-sign",
  "signature": "lowercase-65-byte-signature-hex"
}
```

Each shared value appears in the signed message above, so the signature covers it;
the `values` object is the same data in JSON.

The client delivers the response by opening the redirect URL in the browser with
the response in the URL fragment, so it is not sent to the server or leaked
through referrers:

```text
https://app.example/connect/cb#result=<base64url-encoded-response-json>
```

Desktop opens this automatically. The CLI opens it with the system browser, or
prints the URL for the user to open.

The web app finds its pending request by `challenge`, then MUST verify: `version`
is `1`; `kind` is `antseed.connect.response`; the challenge exists and has not
been used; `values` contains only the scopes that were requested, each well-formed; the
signature recovers the account address over the message rebuilt from the request's
`redirect`, `challenge`, and `scopes` plus the returned values; and, for the
`address` scope, `values.address` equals the recovered signer. The web app MUST
mark the challenge used atomically with successful verification.

## 10. Web App Manifest

A web app MAY publish a manifest so the client can show its name and icon on the
consent screen:

```text
GET https://app.example/.well-known/antseed-connect.json
```

```json
{
  "version": 1,
  "kind": "antseed.connect.manifest",
  "name": "Example App",
  "homepage": "https://app.example",
  "icon": "https://app.example/icon.png"
}
```

`homepage` and `icon` MUST be same-origin with the manifest URL and HTTPS in
production. The manifest is optional and display-only: the client always shows the
origin from the redirect URL with or without a manifest, and never relies on the
manifest for a security decision. There is no protocol-level registry of web apps.

## 11. Security Requirements

Clients MUST:

- Derive the requesting origin from the redirect URL and use only that origin as
  the security identity for display and signing. Never trust an origin or name
  supplied separately in the link.
- Reject non-HTTPS redirect URLs in production, except loopback development URLs.
- Reject redirect URLs with username, password, or fragment components.
- Ask for explicit user consent before sharing any scope.
- Sign only the response message defined here, as raw EIP-191 with no added
  prefix, and validate every field before signing.
- Deliver the response only to the redirect URL.
- Never send private keys, bearer tokens, config contents, ReserveAuth,
  SpendingAuth, local stores, or wallet secrets to a web app.

Web apps MUST:

- Use single-use challenges of at least 128 bits, expired server-side and marked
  used atomically with successful verification.
- Verify the signature before trusting a shared value.
- Not request private keys, ReserveAuth, SpendingAuth, config, or bearer tokens.

## 12. CLI Command

```bash
antseed connect "<request-link>"
```

`antseed connect "<request-link>"` runs the information request flow from a
request link (Section 6) and opens the redirect URL in the browser (or prints it)
to deliver the signed response.

## 13. Desktop Deep Link

```text
antseed://connect?version=1&redirect=<urlencoded>&scopes=<scopes>&challenge=<challenge>
```

Desktop registers the `antseed://` scheme, validates the link (Section 6), runs
the flow, and delivers the response by navigating the browser to the redirect URL
with the response in the fragment (Section 9).

## 14. Versioning

This specification defines version `1` payloads. Implementations MUST reject an
unknown `version` in request links, responses, and manifests. They MAY
ignore unknown fields in version `1` payloads, but unknown fields MUST NOT appear
in signed messages or change the meaning of signed fields.

## 15. Application: Funding Deposits

Funding lets a web app (a *funding gateway*) help a user add Base USDC to their
`AntseedDeposits` balance. It is an adjunct to the payments protocol in
[04-payments.md](./04-payments.md) and is not part of buyer-seller negotiation,
metering, settlement, or reputation.

Funding uses Connect for one thing: learning the user's Buyer address. Everything
else is the gateway's own checkout and on-chain verification by the client. There
is no signed "funding request": the gateway already knows its chain and contract,
the user picks the amount, and the funding wallet's own transaction prompt is the
consent for moving money.

### 15.1 The Deposit Call

```solidity
AntseedDeposits.deposit(address buyer, uint256 amount)
```

`deposit` credits `buyer` and pulls USDC from `msg.sender`, so the funding wallet
can be a different identity than the Buyer. The contract is the final enforcer of
minimum deposit, credit limit, allowance, balance, and amount validity.

### 15.2 Getting the Buyer Address

The funding gateway opens a request link (Section 6) for the `address` scope, with
its own callback as the redirect URL. The signed account address it receives is
the Buyer to credit.

### 15.3 Funding and Verification

With the address, the gateway shows a checkout using its own configured chain and
`AntseedDeposits` contract, then has the funding wallet obtain USDC, approve the
contract, and call `deposit(buyer, amount)`. The gateway MUST show the destination
address, chain, contract, and amount before the wallet submits.

A malicious gateway could mislead the user into an incorrect wallet transaction,
and the client cannot prevent that. The client therefore confirms funding only
from the chain, which is the source of truth. The client verifies on its own
configured `chainId` and `depositsContract`, never values supplied by the gateway.

A deposit is confirmed when the chain shows a
`Deposited(address indexed buyer, uint256 amount)` event from the configured
contract crediting the expected address, or equivalently an increase in
`getBuyerBalance(buyer)`. The client reflects the authoritative on-chain balance;
it does not attribute a deposit to a specific session, because `Deposited` carries
no such link.
