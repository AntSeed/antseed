import { getAddress, ZeroAddress } from 'ethers';
import { BrowserSigning } from '../../../src/browser-signer';
import { JobRunner } from '../../../src/job-runner';
import { AntsContext, type AntsChainConfig } from '../../../src/service/context';
import * as service from '../../../src/service/index';
import { sellerModels } from '../../../src/service/seller-models';
import { mergePositionBarrier, positionIdsInReceipt } from '../../../src/service/position-barrier';
import type { ClaimRequest, CompoundRequest, ExtendRequest, JobView, MaxLockRequest, MergeRequest, MoveRequest, RestakeRequest, SplitRequest, StakeRequest, StakeUsageRequest, SubmitProofRequest, WithdrawRequest } from '../../../src/api-types';
import type { StepReporter } from '../../../src/service/steps';
import type { DashboardConfig } from '../api';
import type { DashboardTransport } from '../runtime';
import { invalidateAll } from '../data';
import { BuyerStore, verifyBuyer } from './buyers';
import { ActivityStore, withWalletLock } from './activity';

type RequestInit = { method?: string; body?: unknown };
type Body = Record<string, unknown> | undefined;
type Run = (ctx: AntsContext, body: never, report: StepReporter) => Promise<unknown>;

interface ActionSpec {
  kind: string;
  /** Whether the action spends from the selected buyer account, which needs a live operator check first. */
  buyer?: (body: never) => boolean;
  run: Run;
}

/** Signing actions the local server exposes as POST routes, keyed by that route. */
const ACTIONS: Record<string, ActionSpec> = {
  '/api/positions/stake': { kind: 'stake', run: (ctx, body: StakeRequest, report) => service.stake(ctx, body, report) },
  '/api/positions/move': { kind: 'move', run: (ctx, body: MoveRequest, report) => service.move(ctx, body, report) },
  '/api/positions/split': { kind: 'split', run: (ctx, body: SplitRequest, report) => service.split(ctx, body, report) },
  '/api/positions/merge': { kind: 'merge', run: (ctx, body: MergeRequest, report) => service.merge(ctx, body, report) },
  '/api/positions/max-lock': { kind: 'max-lock', run: (ctx, body: MaxLockRequest, report) => service.maxLock(ctx, body, report) },
  '/api/positions/extend': { kind: 'extend', run: (ctx, body: ExtendRequest, report) => service.extend(ctx, body, report) },
  '/api/positions/withdraw': { kind: 'withdraw', run: (ctx, body: WithdrawRequest, report) => service.withdraw(ctx, body, report) },
  '/api/rewards/claim': { kind: 'claim', buyer: (body: ClaimRequest) => body.scope === 'buyer' || body.buckets.includes('buyer'), run: (ctx, body: ClaimRequest, report) => service.claim(ctx, body, report) },
  '/api/rewards/restake': { kind: 'restake', run: (ctx, body: RestakeRequest, report) => service.restake(ctx, body, report) },
  '/api/rewards/stake-usage': { kind: 'stake-usage', buyer: (body: StakeUsageRequest) => body.side === 'buyer', run: (ctx, body: StakeUsageRequest, report) => service.stakeUsageRewards(ctx, body, report) },
  '/api/rewards/compound': { kind: 'compound', buyer: (body: CompoundRequest) => body.includeBuyer !== false, run: (ctx, body: CompoundRequest, report) => service.compound(ctx, body, report) },
  '/api/verification/submit': { kind: 'verify-submit', run: (ctx, body: SubmitProofRequest, report) => service.submitProof(ctx, body.artifact, report) },
  '/api/seller/register': { kind: 'seller-register', run: (ctx, body: { agentId?: number }, report) => service.registerBinding(ctx, body.agentId, report) },
  '/api/seller/claim-starter': { kind: 'claim-starter', run: (ctx, _body, report) => service.claimStarter(ctx, report) },
};

const STORAGE_UNAVAILABLE = 'Browser activity storage is unavailable. Wallet actions are disabled.';
const TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * In-browser replacement for the local dashboard server: the same service
 * layer, driven by the connected wallet, with buyer accounts, job history and
 * transaction recovery kept in browser storage.
 */
export class HostedRuntime implements DashboardTransport {
  readonly mode = 'hosted' as const;
  readonly buyers: BuyerStore;
  readonly activity: ActivityStore;
  private context: AntsContext;
  private bridge: BrowserSigning;
  private wallet: string | null = null;
  private jobs = new JobRunner();
  private readonly runners = new Map<string, JobRunner>();
  private activeJob: JobView | null = null;
  /** Bumped on wallet or buyer change so in-flight actions and reads notice they belong to a previous identity. */
  private generation = 0;
  private writeError: string | undefined;
  private transactionError: string | undefined;
  private validateAction: (() => Promise<void>) | undefined;

  constructor(readonly chain: AntsChainConfig, readonly projectId: string, storage: Storage | null, private readonly locks: Pick<LockManager, 'request'> | undefined, private readonly tabId: string = globalThis.crypto.randomUUID()) {
    this.buyers = new BuyerStore(storage);
    this.activity = new ActivityStore(storage, chain.evmChainId);
    this.context = new AntsContext({ chain, address: ZeroAddress, buyerAddress: null });
    this.bridge = new BrowserSigning(chain.evmChainId);
    if (!locks) this.writeError = 'Wallet actions require Web Locks support and HTTPS.';
    if (!storage) this.writeError = 'Browser storage is required for safe transaction recovery.';
  }

  async request<T>(path: string, init?: RequestInit): Promise<T> {
    if (this.wallet) {
      try {
        const barrier = this.activity.positionBarrier(this.wallet);
        if (barrier) this.context.positionReadBarriers.set(this.wallet.toLowerCase(), barrier);
      } catch { this.writeError = STORAGE_UNAVAILABLE; }
    }
    const generation = this.generation;
    const result = await this.dispatch(path, init);
    if (!init?.method && generation !== this.generation) throw new Error('Account changed while loading. Refresh this view.');
    return result as T;
  }

  private get blockedReason(): string | undefined {
    return this.writeError ?? this.transactionError;
  }

  private get running(): boolean {
    return this.activeJob?.status === 'running';
  }

  private config(): DashboardConfig {
    const list = this.wallet ? this.buyers.load(this.chain.evmChainId, this.wallet) : { buyers: [], selected: null };
    return {
      mode: 'hosted', address: this.wallet ?? ZeroAddress, buyerAddress: list.selected,
      buyerLabel: list.buyers.find(buyer => buyer.address === list.selected)?.label,
      browserWallet: true, canAuthorize: false, readOnly: !this.wallet || !!this.blockedReason,
      writeUnavailableReason: this.blockedReason,
      chainId: this.chain.chainId, evmChainId: this.chain.evmChainId, walletRpcUrl: this.chain.rpcUrl,
      walletConnectProjectId: this.projectId, dataDir: '',
    };
  }

  /** A fresh service context for the current wallet and its selected buyer, with locally confirmed positions restored. */
  private resetContext(): void {
    this.generation++;
    const wallet = this.wallet;
    const buyerAddress = wallet ? this.buyers.load(this.chain.evmChainId, wallet).selected : null;
    this.context = new AntsContext({ chain: this.chain, address: wallet ?? ZeroAddress, buyerAddress });
    if (!wallet) return;
    try {
      for (const [positionId, owner] of this.activity.read<Array<[number, string]>>(wallet, 'positions', [])) this.context.localPositionIds.set(positionId, owner);
    } catch { this.writeError = STORAGE_UNAVAILABLE; }
  }

  private syncWallet(address: string | undefined, chainId: number | undefined, disconnect: boolean): boolean {
    const next = address && chainId === this.chain.evmChainId ? getAddress(address) : null;
    if (next === this.wallet || (!next && !disconnect)) return false;
    this.bridge.cancel();
    this.wallet = next;
    this.resetContext();
    this.jobs = next ? this.jobsFor(next) : new JobRunner();
    return true;
  }

  /** One job history per wallet, persisted per tab so a reload shows what this tab started. */
  private jobsFor(wallet: string): JobRunner {
    const existing = this.runners.get(wallet);
    if (existing) return existing;
    try {
      this.activity.write(wallet, 'probe', true);
      const runner = new JobRunner({
        storage: { load: () => this.activity.read(wallet, `${this.tabId}:jobs`, []), save: jobs => this.activity.write(wallet, `${this.tabId}:jobs`, jobs) },
        onFinish: () => { this.context.invalidate(); invalidateAll({ confirmed: true }); },
      });
      this.runners.set(wallet, runner);
      return runner;
    } catch (error) {
      this.writeError = error instanceof Error ? error.message : String(error);
      return new JobRunner();
    }
  }

  private requireWalletIdle(): string {
    if (this.running) throw new Error('Wait for the current action before changing buyer accounts.');
    if (!this.wallet) throw new Error('Connect your wallet first.');
    return this.wallet;
  }

  private start(path: string, body: unknown): JobView {
    const spec = ACTIONS[path];
    if (!spec) throw new Error(`Unknown dashboard action: ${path}`);
    const wallet = this.wallet;
    if (!wallet) throw new Error('Connect your wallet first.');
    if (this.blockedReason) throw new Error(this.blockedReason);
    if (this.running) throw new Error('Wait for the previous wallet action.');
    const ctx = this.context;
    const generation = this.generation;
    const spendsBuyer = spec.buyer?.(body as never) ?? false;
    const validate = async () => {
      if (this.wallet !== wallet || this.generation !== generation) throw new Error('Wallet or buyer changed. Review completed transactions before starting again.');
      if (spendsBuyer) {
        if (!ctx.buyerAddress) throw new Error('Select a buyer account first.');
        ctx.invalidate();
        const operator = await ctx.deposits()?.getOperator(ctx.buyerAddress);
        if (!operator || operator.toLowerCase() !== wallet.toLowerCase()) throw new Error('This wallet is no longer authorized for the selected buyer.');
      }
      if (this.wallet !== wallet || this.generation !== generation) throw new Error('Wallet or buyer changed during authorization checks.');
    };
    const bridge = new BrowserSigning(this.chain.evmChainId, {
      beforeSend: validate,
      persist: request => {
        try { this.activity.record(request, ctx.buyerAddress); }
        catch (error) { this.transactionError = 'Transaction recovery could not be saved. Keep this tab open and check your wallet before retrying.'; throw error; }
      },
    });
    this.validateAction = validate;
    this.bridge = bridge;
    ctx.signer = bridge.signer(wallet, ctx.provider());
    const job = this.jobs.start(spec.kind, report => withWalletLock(this.locks, this.chain.evmChainId, wallet, async () => {
      await validate();
      await this.requireNoUnresolvedApproval(ctx, wallet);
      const reportAndRemember: StepReporter = async (label, hash) => {
        if (hash) {
          try { await this.rememberTransaction(ctx, wallet, hash); }
          catch { await report('Position history could not be saved. Confirmed transactions are still recorded.'); }
        }
        await report(label, hash);
      };
      try { return await spec.run(ctx, body as never, reportAndRemember); }
      finally { ctx.signer = undefined; ctx.invalidate(); }
    }), wallet);
    this.activeJob = job;
    return job;
  }

  /** A previous approval whose outcome is unknown must be resolved before another transaction is signed. */
  private async requireNoUnresolvedApproval(ctx: AntsContext, wallet: string): Promise<void> {
    for (const record of this.unresolvedApprovals(wallet)) {
      if (!record.submittedHash || await this.activity.track(ctx.provider(), record) === 'pending') {
        throw new Error('Resolve the previous wallet approval in Account → Transaction recovery before starting another action.');
      }
    }
  }

  private unresolvedApprovals(wallet: string) {
    return this.activity.transactions(wallet).filter(record => !record.resolved && (record.approvalStarted || record.submittedHash));
  }

  /** After a confirmed transaction: advance the read barrier and remember any position ids it minted. */
  private async rememberTransaction(ctx: AntsContext, wallet: string, hash: string): Promise<void> {
    const receipt = await ctx.provider().getTransactionReceipt(hash);
    if (receipt?.status !== 1) return;
    const key = wallet.toLowerCase();
    ctx.positionReadBarriers.set(key, mergePositionBarrier(ctx.positionReadBarriers.get(key), receipt.blockNumber));
    this.activity.confirmPositionRead(wallet, receipt.blockNumber);
    const ids = positionIdsInReceipt(receipt, this.chain.sellerPoolsAddress);
    if (ids.length === 0) return;
    for (const position of await ctx.requirePools().positionsBatch(ids)) {
      if (position.owner.toLowerCase() === key) ctx.localPositionIds.set(position.id, position.owner);
    }
    this.activity.write(wallet, 'positions', [...ctx.localPositionIds]);
  }

  private async dispatch(path: string, init?: RequestInit): Promise<unknown> {
    const url = new URL(path, 'https://dashboard.invalid');
    const body = init?.body as Body;
    if (url.pathname === '/api/config') return this.config();
    if (url.pathname.startsWith('/api/wallet')) return this.walletRoute(url.pathname, body);
    if (url.pathname.startsWith('/api/hosted/buyers')) return this.buyerRoute(url.pathname, body);
    if (url.pathname.startsWith('/api/hosted/recovery')) return this.recoveryRoute(url.pathname, body);
    if (url.pathname === '/api/jobs') return this.jobs.list(this.wallet ?? ZeroAddress).map(job => ({ ...job, steps: [...job.steps] }));
    if (url.pathname.startsWith('/api/jobs/')) return this.jobs.list(this.wallet ?? ZeroAddress).find(job => job.id === url.pathname.slice('/api/jobs/'.length));
    if (url.pathname === '/api/positions/withdraw/preview') return service.previewWithdraw(this.context, body?.positionIds as number[]);
    if (init?.method === 'POST') return this.start(url.pathname, body ?? {});
    return this.read(url);
  }

  private async walletRoute(pathname: string, body: Body): Promise<unknown> {
    switch (pathname) {
      case '/api/wallet': {
        const changed = this.syncWallet(body?.address as string | undefined, body?.chainId as number | undefined, body?.disconnect === true);
        if (body?.refresh) this.context.invalidate();
        return { changed };
      }
      case '/api/wallet/request': {
        const transaction = this.bridge.request;
        return transaction ? { ...transaction, jobId: this.activeJob?.id } : null;
      }
      case '/api/wallet/begin': {
        const pending = this.bridge.request;
        if (!pending || this.wallet !== pending.from || this.context.address !== pending.from) throw new Error('Reconnect the original signing wallet.');
        await this.validateAction?.();
        this.bridge.begin(String(body?.id));
        return {};
      }
      case '/api/wallet/result': {
        const pending = this.bridge.request;
        await this.bridge.complete(String(body?.id), body?.hash as string | undefined, body?.error as string | undefined);
        if (pending && body?.error && !pending.approvalStarted) this.activity.resolve(pending.from, pending.id);
        return {};
      }
      default: throw new Error(`Unknown dashboard read: ${pathname}`);
    }
  }

  private async buyerRoute(pathname: string, body: Body): Promise<unknown> {
    const chainId = this.chain.evmChainId;
    if (pathname === '/api/hosted/buyers') {
      const list = this.wallet ? this.buyers.load(chainId, this.wallet) : { buyers: [], selected: null };
      return { ...list, persistent: this.buyers.persistent };
    }
    if (pathname === '/api/hosted/buyers/verify') {
      const ctx = this.context;
      return verifyBuyer(this.buyers.address(String(body?.address)), this.wallet ?? ZeroAddress, async buyer => {
        const deposits = ctx.deposits();
        if (!deposits) throw new Error('Deposits contract is unavailable.');
        ctx.invalidate();
        return deposits.getOperator(buyer);
      });
    }
    const wallet = this.requireWalletIdle();
    const address = String(body?.address ?? '');
    const label = String(body?.label ?? '');
    switch (pathname) {
      case '/api/hosted/buyers/add': this.buyers.add(chainId, wallet, address, label); break;
      case '/api/hosted/buyers/select': this.buyers.select(chainId, wallet, address || null); break;
      case '/api/hosted/buyers/rename': this.buyers.rename(chainId, wallet, address, label); break;
      case '/api/hosted/buyers/remove': this.buyers.remove(chainId, wallet, address); break;
      default: throw new Error('Unknown buyer action.');
    }
    this.resetContext();
    invalidateAll({ clear: true });
    return {};
  }

  private async recoveryRoute(pathname: string, body: Body): Promise<unknown> {
    if (pathname === '/api/hosted/recovery') return this.listRecovery();
    if (pathname !== '/api/hosted/recovery/resolve') throw new Error(`Unknown dashboard read: ${pathname}`);
    const wallet = this.requireWalletIdle();
    const ctx = this.context;
    return withWalletLock(this.locks, this.chain.evmChainId, wallet, async () => {
      const record = this.activity.transactions(wallet).find(entry => entry.id === body?.id);
      if (!record) throw new Error('Unknown approval.');
      if (body?.hash) {
        const hash = String(body.hash);
        if (!TRANSACTION_HASH.test(hash)) throw new Error('Invalid transaction hash.');
        this.activity.record({ ...record, submittedHash: hash }, record.buyer);
        record.submittedHash = hash;
      }
      if (record.submittedHash) return { status: await this.activity.track(ctx.provider(), record) };
      if (body?.confirmedNotSubmitted !== true) throw new Error('Check your wallet and confirm no transaction was submitted.');
      this.activity.resolve(wallet, record.id);
      return { status: 'cleared' };
    });
  }

  /** Unresolved approvals, after a best-effort check of the ones that already have a hash. */
  private async listRecovery(): Promise<unknown> {
    const wallet = this.wallet;
    if (!wallet) return [];
    const ctx = this.context;
    if (!this.running && this.locks) {
      try {
        await withWalletLock(this.locks, this.chain.evmChainId, wallet, async () => {
          for (const record of this.activity.transactions(wallet).filter(record => !record.resolved && record.submittedHash)) {
            try { await this.activity.track(ctx.provider(), record); } catch { /* left for the user to resolve */ }
          }
        });
      } catch { /* another tab holds the wallet; show the records as they are */ }
    }
    return this.unresolvedApprovals(wallet);
  }

  private read(url: URL): Promise<unknown> {
    const ctx = this.context;
    const last = decodeURIComponent(url.pathname.split('/').at(-1)!);
    switch (url.pathname) {
      case '/api/overview': return service.overview(ctx);
      case '/api/positions': return service.positions(ctx);
      case '/api/rewards': return service.rewards(ctx);
      case '/api/pools': return service.poolsView(ctx);
      case '/api/usage': return service.usage(ctx, { epochs: Number(url.searchParams.get('epochs') ?? 8) });
      case '/api/emissions': return service.emissions(ctx);
      case '/api/verification': return service.verification(ctx, url.searchParams.get('seller') ?? undefined);
      case '/api/seller': return service.seller(ctx);
    }
    if (url.pathname.startsWith('/api/pools/')) return service.singlePool(ctx, Number(last));
    if (url.pathname.startsWith('/api/verification/proofs/')) return service.proofStatus(ctx, last);
    if (/^\/api\/sellers\/[^/]+\/models$/.test(url.pathname)) return sellerModels(this.chain.explorerApiUrl, decodeURIComponent(url.pathname.split('/')[3]!));
    throw new Error(`Unknown dashboard read: ${url.pathname}`);
  }
}
