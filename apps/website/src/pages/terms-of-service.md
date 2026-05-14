---
title: Terms of Service
description: AntSeed Terms of Service
slug: /terms-of-service
---

# AntSeed Terms of Service

**Last Updated: May 11, 2026**

---

## 1. About These Terms

These Terms of Service ("Terms") govern your access to and use of: the AntSeed open-source Protocol; the AntStation desktop application; the AntSeed CLI; the smart contracts deployed on the Base blockchain (including AntseedDeposits, AntseedChannels, AntseedStaking, AntseedEmissions, and ANTSToken); the DIEM staking pool accessible at diem.antseed.com; and any related documentation, software, or interfaces (collectively, the "Protocol" or "Services").

These Terms are published by the AntSeed open-source project ("AntSeed," "we," "us," or "our"). AntSeed is not incorporated in any jurisdiction. It is a decentralized, open-source protocol with no headquarters, no registered entity, and no jurisdiction-specific legal domicile. These Terms are provided in the same spirit as open-source protocols such as BitTorrent: as a statement of the terms under which the software and interfaces are made available to the public, and as a clear allocation of responsibility between the protocol and its users.

By installing, accessing, or using any part of the Protocol or any interface operated by AntSeed, you confirm you have read, understood, and agree to be bound by these Terms in their entirety. If you do not agree, do not use the Protocol.

These Terms apply to all participants: **Buyers** (consumers of AI services on the network), **Providers** (operators who offer AI services on the network), **Stakers** (participants in the DIEM staking pool), and **Developers** (those who build on or extend the Protocol).


---

## 2. What AntSeed Is — And What It Is Not

### 2.1 A Communication Protocol, Not a Service Provider

AntSeed is an **open-source, peer-to-peer communication protocol**. It provides a neutral technical layer through which independent peers discover each other, negotiate terms, exchange data, and settle payments for AI inference services — directly, with no company in the middle.

AntSeed occupies the same role in the AI services stack as **BitTorrent occupies in file distribution** or **TCP/IP occupies in internet communication**: a neutral transport and coordination mechanism. AntSeed facilitates the connection between peers; it does not participate in, direct, control, or benefit from the substance of what is exchanged between them.

Like BitTorrent DHT and similar decentralized infrastructure protocols, AntSeed:

- Does not host, store, transmit, process, or inspect any content exchanged between peers.
- Does not operate any centralized server, broker, or relay through which peer traffic passes.
- Does not know the real-world identity of any Provider or Buyer operating on the network.
- Does not control, screen, approve, endorse, or curate any service offered or consumed by any peer.
- Has no "off switch" — the network is defined entirely by the set of active nodes running the open-source software. To shut down any service on the network, every individual node serving it would need to be shut down independently.

Discovery happens via **BitTorrent DHT**. Transport happens via **WebRTC**, encrypted end-to-end. Payments settle directly on the **Base blockchain** via smart contracts. At no point does any traffic, payment, or negotiation pass through infrastructure controlled or operated by AntSeed.

### 2.2 No Knowledge of Network Activity

AntSeed has no technical ability to monitor, inspect, log, or intercept the content of any request, response, or communication between peers. We do not know:

- Who specific Providers or Buyers are.
- What services any Provider is actually delivering.
- What prompts, completions, or data are exchanged in any session.
- Whether any Provider is operating in compliance with any upstream API provider's terms of service or applicable law.

**You use the network at your own risk, with full awareness that you are transacting directly with anonymous, pseudonymous, or unverified third-party peers.**


---

## 3. Eligibility

You must be at least 18 years of age (or the age of legal majority in your jurisdiction, whichever is greater) to use the Protocol or participate in the DIEM staking pool. By using any part of the Protocol, you represent and warrant that you meet this requirement.

If you are using the Protocol on behalf of a legal entity, you represent and warrant that you have authority to bind that entity to these Terms.

You further represent that you are not subject to economic or trade sanctions administered by any governmental authority, and that you are not located in a jurisdiction subject to comprehensive sanctions (including OFAC-designated jurisdictions). Your use of the Protocol, including participation in the DIEM staking pool or any on-chain payment activity, must comply fully with all applicable laws and regulations in your jurisdiction.

---

## 4. The Peer-to-Peer Network — Unknown Counterparties and Absence of Vetting

### 4.1 Anonymous and Unverified Peers

**The AntSeed network consists entirely of independent, anonymous, and unverified third-party peers.** AntSeed does not vet, license, certify, background-check, or approve any Provider or Buyer. You should treat every counterparty as an unknown third party.

When you connect to a Provider node:
- You do not know who operates that node or where they are located.
- You do not know what model, infrastructure, or upstream service that Provider is using.
- You do not know whether the Provider's service complies with any applicable law or upstream terms of service.
- You do not know whether any claims the Provider makes about their service are accurate.

**Exercise extreme caution.** The on-chain reputation system (ghost counts, settlement volume, channel history) provides pseudonymous signals. These are not endorsements by AntSeed and do not verify the legitimacy, safety, or legal compliance of any Provider.

### 4.2 No Endorsement of Any Peer, Service, or Output

AntSeed does not recommend, endorse, sponsor, promote, or guarantee any Provider, Buyer, service, model, agent, workflow, content, or AI output available on the network. The appearance of any node in DHT discovery results is a technical artifact of the protocol — it is not a listing, a recommendation, or an endorsement by AntSeed. We do not maintain a curated registry of approved providers.

### 4.3 Provider Privacy Practices Unknown

AntSeed has no knowledge of, and takes no responsibility for, the data handling, logging, retention, or privacy practices of any Provider on the network. **You should assume that Providers may log your prompts and responses** unless you have independent, cryptographic verification (such as a verified Trusted Execution Environment attestation) that they do not.


---

## 5. Provider Obligations, Liability, and Prohibited Conduct

### 5.1 Providers Are Solely and Fully Responsible for What They Provide

**If you operate as a Provider on the AntSeed network, you bear full and exclusive legal and financial responsibility for every aspect of the services you offer.** This includes, without limitation:

- The legality of your service in every jurisdiction where you serve Buyers.
- The accuracy, safety, and quality of your outputs.
- Your compliance with all applicable laws and regulations, including laws governing the provision of AI services, data protection, consumer protection, export controls, and financial regulations.
- Your compliance with the terms of service, usage policies, and license agreements of any upstream AI API, model provider, cloud service, or infrastructure provider you use to deliver your service.
- Any harm caused to Buyers or third parties by your service or its outputs.
- Any claims, fines, penalties, or damages arising from your operation as a Provider.

AntSeed is a protocol layer. **AntSeed is not a party to any agreement between you and any Buyer, and is not a party to any agreement between you and any upstream service provider.** AntSeed does not direct, control, supervise, or take any share of responsibility for what you provide.

### 5.2 Upstream API Terms of Service — Explicit Prohibitions

The following conduct is **expressly prohibited** on the AntSeed network. Engaging in any of these activities is a violation of these Terms and may expose you to legal liability from upstream providers, regulators, or harmed parties:

**5.2.1 Subscription and Credential Resale (Strictly Prohibited)**
You must not offer services on the AntSeed network that constitute the resale, sublicensing, sharing, or commercial exploitation of any third-party AI provider's personal-use, consumer, or non-commercial subscription tier. Personal and consumer subscriptions offered by AI providers are licensed for individual, non-commercial use only. Reselling or sublicensing access to such subscriptions — regardless of how it is packaged or priced — violates the terms of service of those providers, may constitute breach of contract or unauthorized access under applicable law, and is prohibited on this network.

If you operate as a Provider and use any third-party API or service to fulfil requests, you must hold the appropriate commercial API access credentials for that service and comply fully with all applicable usage policies. **The AntSeed subscription-based provider plugin is provided strictly for local development and testing only. It must never be used in production to serve paying network Buyers.**

**5.2.2 Unauthorized Commercial Use of Non-Commercial Licenses**
You must not use AI models, model weights, or APIs made available under non-commercial, research-only, or restricted licenses to provide commercial inference services on this network without explicit, written authorization from the rights holder.

**5.2.3 Misrepresentation**
You must not falsely represent the model you are serving, the nature or capabilities of your service, your compliance status, the identity of any upstream provider, or any other material fact about your service.

**5.2.4 Circumvention of Upstream Controls**
You must not use the AntSeed network to systematically circumvent authentication, rate limiting, content filtering, access controls, or usage monitoring mechanisms of any upstream API provider.

### 5.3 General Prohibited Conduct — All Users

All users (Buyers, Providers, Stakers, and Developers) agree not to use the Protocol to:

- Violate any applicable local, national, or international law or regulation.
- Generate, transmit, or distribute content that is illegal, including but not limited to child sexual abuse material (CSAM), content facilitating terrorism or organized crime, or unlawful threats.
- Engage in money laundering, fraud, sanctions evasion, or any financial crime.
- Infringe the intellectual property rights of any third party.
- Circumvent export controls or trade restrictions applicable to AI technology.
- Intentionally harm, harass, stalk, or defraud any individual or entity.
- Interfere with or attack the protocol infrastructure, including attempting to exploit smart contracts, manipulate reputation scores, or disrupt peer connections.


---

## 6. DIEM Staking Pool — diem.antseed.com

### 6.1 What the DIEM Pool Is

The DIEM staking pool (accessible at diem.antseed.com) is a smart contract deployed on the Base blockchain that allows holders of $DIEM tokens to stake their tokens in exchange for a pro-rata share of USDC revenue generated by the AntSeed Venice Provider node operating on the network, plus periodic $ANTS token emissions. The pool operates entirely on-chain. Staked $DIEM never leaves the Base blockchain and is never held by AntSeed in any custodial capacity.

The pool is currently in **Alpha**. An owner-set cap limits total staked $DIEM during this phase. This cap may be adjusted at any time at the operator's sole discretion.

### 6.2 How USDC Yield Is Generated

USDC yield distributed to stakers is sourced **exclusively** from real inference revenue: USDC paid by Buyers on the AntSeed network for AI inference requests routed through the AntSeed-operated Venice Provider node. Every USDC that enters the pool represents actual payment by a real buyer for actual inference consumption. It is not synthetic yield, printed rewards, or borrowed liquidity.

The flow is:
1. Buyers deposit USDC and submit inference requests to the AntSeed Venice Provider node.
2. The provider node earns USDC per request via on-chain payment channels.
3. That USDC streams directly from the payment channel into the staking contract in real time.
4. The contract distributes USDC to stakers pro-rata, continuously, as it arrives.

### 6.3 Protocol Fees — Staking Pool Fee and Network Fee

Two separate protocol fees apply when using the AntSeed network and staking pool. Neither fee goes to the AntSeed team or any individual in any form. Both are returned to the community of network participants.

**Staking Pool Fee**
A fee of **10% of all USDC inflows** to the staking contract is retained before distribution to stakers. The remaining **90% flows to stakers pro-rata**. This fee is used to sustain and grow the network in a way that drives value back to the community of $ANTS holders and network participants — not to any individual or team member.

**Network Fee**
A network-level fee is applied to all inference transactions settled on the AntSeed protocol. This fee is currently set at **2% of each settled transaction** and may increase over time up to a maximum of **5.5%**. Like the staking pool fee, this fee does not accrue to the AntSeed team or any individual. It is redirected back to benefit the broader community of network participants and $ANTS holders.

Both fee rates are protocol parameters set by the operator. Any change will be reflected on-chain. **The team does not receive any share of either fee stream, any USDC inflows to the staking pool, or any other direct monetary compensation from the Protocol's operations.**

### 6.4 $ANTS Emissions

In addition to USDC yield, stakers receive $ANTS token emissions each epoch (approximately every 3 days). $ANTS emissions are governed by the AntseedEmissions contract and are distributed based on staked position and epoch parameters. $ANTS emissions are a separate income stream from USDC yield. $ANTS is claimed through AntStation (the AntSeed desktop app) using the same wallet address used for staking.

### 6.5 No Guaranteed APY — Variable and Unpredictable Returns

**ANTSEED MAKES NO PROMISE, REPRESENTATION, OR GUARANTEE OF ANY SPECIFIC APY, YIELD RATE, RETURN, OR INCOME FROM STAKING $DIEM.**

Any APY figure displayed on diem.antseed.com (including the "all-time average" or any projected figures) is a **historical calculation based on past performance only**. It is calculated from actual USDC inflows to the pool divided by total staked value over the measured period. It is displayed for informational purposes only.

Your actual returns will depend entirely on:
- The actual volume of inference requests processed by the AntSeed Venice Provider node during any given period.
- The number of $DIEM tokens staked in the pool at the time (your pro-rata share decreases as more tokens are staked).
- Network demand for AI inference, which fluctuates with market conditions, competition, and usage patterns.
- Uptime and operational performance of the AntSeed Venice Provider node.
- Changes to the staking pool fee or the network fee.
- Changes to $ANTS emission schedules or parameters.

**Past yield is not indicative of future yield. Network demand may be zero at any time. Your USDC yield may be zero at any time.** Do not stake $DIEM expecting a specific return. Only stake what you can afford to hold without any guaranteed income.

### 6.6 $DIEM Token Risk

$DIEM is a cryptographic token on the Base blockchain. Staking $DIEM involves the following risks, among others:

- **Price volatility:** The USD value of your staked $DIEM may decrease significantly or go to zero regardless of USDC yield earned.
- **Smart contract risk:** The staking contract may contain bugs or vulnerabilities. An exploit could result in partial or total loss of staked tokens.
- **Liquidity risk:** There may be insufficient market liquidity to sell $DIEM at any given time. Staked $DIEM cannot be sold until unstaked.
- **Regulatory risk:** Regulators may classify $DIEM, $ANTS, or staking activity as a regulated security or financial product in your jurisdiction. You are responsible for determining your legal obligations.
- **No lockup, but cooldown applies:** While there is no minimum staking period, unstaking is subject to a cooldown period (currently 1 day for the Venice provider cooldown). AntSeed may adjust cooldown parameters at any time.

### 6.7 Not a Security, Investment Product, or Financial Advice

Nothing on diem.antseed.com, in these Terms, or in any AntSeed communication constitutes:
- An offer or solicitation to buy or sell any security, investment product, or financial instrument.
- Financial, investment, legal, or tax advice.
- A promise of profit or return on investment.

You are solely responsible for your own investment decisions. Consult a qualified financial and legal advisor before staking any funds.

### 6.8 AntSeed Is Not a Counterparty to Stakers

AntSeed does not hold your $DIEM. AntSeed does not owe you any yield. AntSeed is not a financial institution, fund manager, or fiduciary with respect to your staked tokens. Your relationship is with the smart contract, not with AntSeed. AntSeed has no ability to return staked tokens in the event of a contract exploit.

### 6.9 No Refunds or Recovery

AntSeed cannot reverse, pause, or recover any on-chain transaction. If you lose $DIEM or USDC due to a smart contract exploit, a wallet compromise, a mistaken transaction, or any other reason, AntSeed has no ability to restore those funds and will not do so.


---

## 7. Payments, Smart Contracts, and Security Risks

### 7.1 General Smart Contract Risk

All payments on the AntSeed network — including buyer deposits, payment channel sessions, and DIEM staking — are processed through open-source smart contracts deployed on the Base blockchain. Interacting with any smart contract carries inherent and material risks that you must understand and accept before use:

- **Code vulnerabilities.** Smart contracts are software. Despite design care and any review processes applied, they may contain bugs, logic errors, or vulnerabilities that have not yet been discovered. Any such flaw could be exploited to drain, freeze, or misdirect funds.
- **Exploits and attacks.** Malicious actors actively search for vulnerabilities in deployed smart contracts. Known attack vectors include reentrancy attacks, integer overflow/underflow, flash loan attacks, oracle manipulation, access control flaws, and upgrade mechanism abuse. AntSeed cannot guarantee that its contracts are immune to any of these.
- **No audit guarantee.** Even if the smart contracts have been reviewed or audited by third parties, an audit does not guarantee the absence of vulnerabilities. Audits are point-in-time assessments and do not cover all possible attack surfaces.
- **Irreversibility.** Blockchain transactions are irreversible. If funds are drained through an exploit, there is no mechanism — technical or legal — to reverse the transaction or recover the funds. AntSeed has no ability to pause contracts, freeze funds, or issue refunds in response to an exploit.
- **Upgrades and parameter changes.** Certain contract parameters (such as the operator fee on the staking pool or the Channels contract address via the Registry) may be updated by the operator. While these mechanisms are designed for protocol maintenance, any upgrade process introduces additional risk surface.
- **Dependency risk.** The contracts depend on external systems including the Base blockchain network, Circle's USDC contract, and the ERC-8004 IdentityRegistry. Failures, exploits, or changes in any of these dependencies could affect the Protocol's contracts.
- **Total loss is possible.** In a severe exploit scenario, all funds deposited across all users in an affected contract could be lost in a single transaction. **You should only deposit or stake what you are fully prepared to lose.**

### 7.2 Wallet and Key Security Risk

Your security on the AntSeed network is only as strong as your key management. Risks you must manage independently include:

- **Private key compromise.** If your signing identity key or funding wallet key is compromised, an attacker can drain your deposit balance up to the current balance and sign payment authorizations on your behalf. AntSeed has no mechanism to freeze or recover compromised accounts.
- **Phishing and social engineering.** Malicious actors may attempt to impersonate AntSeed interfaces, nodes, or team members to obtain your keys or signatures. AntSeed will never ask for your private key.
- **Malicious provider nodes.** Providers on the network are anonymous and unvetted. A malicious provider could attempt to extract information from your session, provide harmful outputs, or engage in fraudulent payment behavior. The protocol's cryptographic payment controls bound your financial exposure per session, but do not protect against all forms of provider misconduct.
- **Front-end risk.** If you interact with AntSeed interfaces through a browser or web application, you are exposed to risks including DNS hijacking, BGP hijacking, CDN compromise, and malicious browser extensions that could alter what you see or intercept your signatures.

### 7.3 No Custody

AntSeed does not at any time hold, control, or have access to any user funds. The AntseedDeposits contract is non-custodial. AntSeed holds no admin key or emergency withdrawal capability over deposited user funds.

### 7.4 No Refunds

AntSeed is not a party to any payment channel. We cannot issue refunds, reverse transactions, or resolve disputes. The on-chain `requestClose`/`withdraw` mechanism is the sole recourse for Buyers when a seller is unresponsive.

### 7.5 Blockchain and Stablecoin Risk

AntSeed is not responsible for: network congestion or transaction failures on Base; loss of funds from wallet key compromise; changes to USDC or the Base blockchain; regulatory actions affecting stablecoins or blockchain infrastructure; or the actions or failures of Circle, Coinbase, or any other third party whose infrastructure the Protocol relies upon.

---

## 8. Intellectual Property

### 8.1 Open-Source Protocol

The AntSeed Protocol software is open-source. Your rights to use, copy, modify, and distribute the software are governed by the applicable open-source license(s) in the source code. Nothing in these Terms supersedes those license terms.

### 8.2 No License to Third-Party IP

Nothing in these Terms grants any right to use AI models, model weights, training data, or APIs owned by third parties. All such rights must be obtained separately from the applicable rights holder. AntSeed is not responsible for your compliance with third-party intellectual property rights.

---

## 9. Privacy

### 9.1 Structural Privacy by Design

The AntSeed Protocol is architected so that Buyers are anonymous by default (no account, no sign-up — just a wallet address), Providers may operate pseudonymously, no central server collects communication data, and TEE-equipped providers offer hardware-enforced prompt privacy. These are structural properties of the architecture, dependent on each node's specific implementation and configuration.

### 9.2 AntSeed's Data Collection

AntSeed may collect limited technical data via AntStation and the AntSeed website (e.g., crash reports, version telemetry, website analytics) as described in a separate Privacy Policy. We do not collect or have access to peer-to-peer communication content.

### 9.3 Staking and On-Chain Data

All staking activity on diem.antseed.com is on-chain and publicly visible. Your wallet address, staked amounts, USDC claims, and $ANTS claims are permanently recorded on the Base blockchain. By participating in the staking pool, you acknowledge and accept that this information is public and immutable.

---

## 10. Disclaimers of Warranty

THE PROTOCOL, SOFTWARE, SMART CONTRACTS, STAKING POOL, DOCUMENTATION, AND ALL RELATED SERVICES ARE PROVIDED "AS IS" AND "AS AVAILABLE," WITHOUT WARRANTY OF ANY KIND.

TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, ANTSEED EXPRESSLY DISCLAIMS ALL WARRANTIES, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO:

- WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT.
- ANY WARRANTY THAT THE PROTOCOL OR STAKING POOL WILL BE UNINTERRUPTED, ERROR-FREE, OR SECURE.
- ANY WARRANTY REGARDING THE ACCURACY, QUALITY, LEGALITY, OR SAFETY OF ANY SERVICE OR OUTPUT DELIVERED BY ANY PROVIDER ON THE NETWORK.
- ANY WARRANTY THAT ANY APY, YIELD, RETURN, OR INCOME WILL BE ACHIEVED OR MAINTAINED FROM THE DIEM STAKING POOL.
- ANY WARRANTY THAT ANY PROVIDER IS OPERATING IN COMPLIANCE WITH ANY UPSTREAM TERMS OF SERVICE, LICENSE, OR APPLICABLE LAW.

---

## 11. Limitation of Liability

TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT SHALL ANTSEED, ITS CONTRIBUTORS, MAINTAINERS, OR AGENTS BE LIABLE FOR:

- ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, PUNITIVE, OR EXEMPLARY DAMAGES.
- LOSS OF PROFITS, REVENUE, DATA, TOKENS, USDC, GOODWILL, OR OTHER INTANGIBLE LOSSES.
- LOSS OF CRYPTOCURRENCY, STAKED $DIEM, USDC YIELD, OR $ANTS DUE TO ANY CAUSE.
- DAMAGES ARISING FROM RELIANCE ON ANY PROVIDER OR SERVICE ON THE NETWORK.
- DAMAGES ARISING FROM THE CONDUCT OF ANY THIRD-PARTY PEER ON THE NETWORK.
- DAMAGES ARISING FROM ANY SMART CONTRACT BUG, VULNERABILITY, OR EXPLOIT, INCLUDING IN THE STAKING POOL CONTRACT.
- DAMAGES ARISING FROM REGULATORY ACTION AGAINST $DIEM, $ANTS, OR ANY STAKING ACTIVITY.

THESE LIMITATIONS APPLY REGARDLESS OF THE THEORY OF LIABILITY AND EVEN IF ANTSEED HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.

---

## 12. Indemnification

You agree to indemnify, defend, and hold harmless AntSeed and its contributors, maintainers, and agents from and against any claims, liabilities, damages, losses, and expenses (including reasonable legal fees) arising from:

1. Your access to or use of the Protocol or staking pool.
2. Your violation of these Terms.
3. Your violation of any third party's rights, including upstream AI provider terms of service or intellectual property rights.
4. Any content you generate, transmit, or receive through the Protocol.
5. Your operation as a Provider, including use of any upstream API or service.
6. Any claim by any upstream AI provider arising from your use of their services via the AntSeed network.
7. Any regulatory action arising from your participation in the staking pool or use of $DIEM or $ANTS tokens.

---

## 13. No Jurisdiction — Nature of the Protocol as Open-Source Infrastructure

AntSeed is not a company. It is not incorporated in any jurisdiction. It has no registered office, no directors, no shareholders, and no legal personality under any national law. It is an open-source protocol — software published for public use — in the same manner as BitTorrent, the Lightning Network, or other decentralized infrastructure protocols.

These Terms are published as a statement of intent and a clear allocation of responsibility between the software and its users. They are not a contract governed by the laws of any specific country. To the extent any court finds these Terms to be a binding agreement, the parties agree that the dispute shall be resolved through good-faith negotiation first, and binding arbitration second, under rules and in a venue mutually agreed upon at the time of the dispute.

Nothing in these Terms creates any employment, partnership, joint venture, agency, franchise, or fiduciary relationship between AntSeed and any user.

---

## 14. Modifications to These Terms

AntSeed may modify these Terms at any time by publishing updated Terms at their canonical location. Continued use of the Protocol or staking pool after any update constitutes acceptance of the revised Terms.

---

## 15. Severability

If any provision of these Terms is found invalid or unenforceable, the remaining provisions continue in full force. These Terms constitute the entire agreement between you and AntSeed regarding the Protocol and supersede all prior understandings.

---

## 16. Contact

For questions about these Terms, open an issue or discussion on the official AntSeed GitHub repository.

---

*AntSeed is open-source, decentralized infrastructure. It is a protocol, not a company, not a marketplace, and not a party to any transaction on the network. No service offered by any peer on this network is endorsed, controlled, or guaranteed by AntSeed.*

