import { getAddress, id as eventId, ZeroAddress } from 'ethers';
import { BrowserSigning } from '../../../src/browser-signer';
import { JobRunner } from '../../../src/job-runner';
import { AntsContext, type AntsChainConfig } from '../../../src/service/context';
import * as service from '../../../src/service/index';
import { sellerModels } from '../../../src/service/seller-models';
import type { ClaimRequest, CompoundRequest, ExtendRequest, JobView, MaxLockRequest, MergeRequest, MoveRequest, RestakeRequest, SplitRequest, StakeRequest, StakeUsageRequest, SubmitProofRequest, WithdrawRequest } from '../../../src/api-types';
import type { StepReporter } from '../../../src/service/steps';
import type { DashboardConfig } from '../api';
import type { DashboardTransport } from '../runtime';
import { invalidateAll } from '../data';
import { BuyerStore, verifyBuyer } from './buyers';
import { ActivityStore, withWalletLock } from './activity';

type Action = { kind: string; buyer: boolean; run: (ctx: AntsContext, report: StepReporter) => Promise<unknown> };

export class HostedRuntime implements DashboardTransport {
  readonly mode = 'hosted' as const;
  readonly buyers: BuyerStore;
  readonly activity: ActivityStore;
  private context: AntsContext;
  private bridge: BrowserSigning;
  private wallet: string | null = null;
  private jobs: JobRunner;
  private readonly runners = new Map<string, JobRunner>();
  private activeJob: JobView | null = null;
  private generation = 0;
  private contextGeneration = 0;
  private writeError: string | undefined;
  private transactionError: string | undefined;
  private validateAction: (() => Promise<void>) | undefined;

  constructor(readonly chain: AntsChainConfig, readonly projectId: string, storage: Storage | null, private readonly locks: Pick<LockManager, 'request'> | undefined, private readonly tabId: string = globalThis.crypto.randomUUID()) {
    this.buyers = new BuyerStore(storage);
    this.activity = new ActivityStore(storage, chain.evmChainId);
    this.context = new AntsContext({ chain, address: ZeroAddress, buyerAddress: null });
    this.bridge = new BrowserSigning(chain.evmChainId);
    this.jobs = new JobRunner();
    if (!locks) this.writeError = 'Wallet actions require Web Locks support and HTTPS.';
    if (!storage) this.writeError = 'Browser storage is required for safe transaction recovery.';
  }

  private config(): DashboardConfig {
    const list = this.wallet ? this.buyers.load(this.chain.evmChainId, this.wallet) : { buyers: [], selected: null };
    return {
      mode: 'hosted', address: this.wallet ?? ZeroAddress, buyerAddress: list.selected,
      buyerLabel: list.buyers.find(buyer => buyer.address === list.selected)?.label,
      browserWallet: true, canAuthorize: false, readOnly: !this.wallet || !!this.writeError || !!this.transactionError,
      writeUnavailableReason: this.writeError ?? this.transactionError,
      chainId: this.chain.chainId, evmChainId: this.chain.evmChainId, walletRpcUrl: this.chain.rpcUrl,
      walletConnectProjectId: this.projectId, dataDir: '',
    };
  }

  private syncWallet(address: string | undefined, chainId: number | undefined, disconnect?: boolean): boolean {
    const next = address && chainId === this.chain.evmChainId ? getAddress(address) : null;
    if (next === this.wallet || (!next && !disconnect)) return false;
    this.generation++;
    this.contextGeneration++;
    this.bridge.cancel();
    this.wallet = next;
    const buyerAddress = next ? this.buyers.load(this.chain.evmChainId, next).selected : null;
    this.context = new AntsContext({ chain: this.chain, address: next ?? ZeroAddress, buyerAddress });
    if (next) {
      try {
        this.activity.write(next, 'probe', true);
        this.jobs = this.runners.get(next) ?? new JobRunner({
          storage: { load: () => this.activity.read(next, `${this.tabId}:jobs`, []), save: jobs => this.activity.write(next, `${this.tabId}:jobs`, jobs) },
          onFinish: () => { this.context.invalidate(); invalidateAll({ confirmed: true }); },
        });
        this.runners.set(next, this.jobs);
        for (const [positionId, owner] of this.activity.read<Array<[number, string]>>(next, 'positions', [])) this.context.localPositionIds.set(positionId, owner);
      } catch (error) {
        this.writeError = error instanceof Error ? error.message : String(error);
        this.jobs = new JobRunner();
      }
    } else this.jobs = new JobRunner();
    return true;
  }

  private assertBuyerChange(): string {
    if (this.activeJob?.status === 'running') throw new Error('Wait for the current action before changing buyer accounts.');
    if (!this.wallet) throw new Error('Connect your wallet first.');
    return this.wallet;
  }

  private refreshBuyer(): void {
    this.generation++;
    this.contextGeneration++;
    this.context = new AntsContext({ chain: this.chain, address: this.wallet ?? ZeroAddress, buyerAddress: this.wallet ? this.buyers.load(this.chain.evmChainId, this.wallet).selected : null });
    if (this.wallet) {
      try { for (const [positionId, owner] of this.activity.read<Array<[number, string]>>(this.wallet, 'positions', [])) this.context.localPositionIds.set(positionId, owner); }
      catch { this.writeError = 'Browser activity storage is unavailable. Wallet actions are disabled.'; }
    }
    invalidateAll({ clear: true });
  }

  private action(path: string, body: unknown): Action {
    switch (path) {
      case '/api/positions/stake': return { kind: 'stake', buyer: false, run: (ctx, report) => service.stake(ctx, body as StakeRequest, report) };
      case '/api/positions/move': return { kind: 'move', buyer: false, run: (ctx, report) => service.move(ctx, body as MoveRequest, report) };
      case '/api/positions/split': return { kind: 'split', buyer: false, run: (ctx, report) => service.split(ctx, body as SplitRequest, report) };
      case '/api/positions/merge': return { kind: 'merge', buyer: false, run: (ctx, report) => service.merge(ctx, body as MergeRequest, report) };
      case '/api/positions/max-lock': return { kind: 'max-lock', buyer: false, run: (ctx, report) => service.maxLock(ctx, body as MaxLockRequest, report) };
      case '/api/positions/extend': return { kind: 'extend', buyer: false, run: (ctx, report) => service.extend(ctx, body as ExtendRequest, report) };
      case '/api/positions/withdraw': return { kind: 'withdraw', buyer: false, run: (ctx, report) => service.withdraw(ctx, body as WithdrawRequest, report) };
      case '/api/rewards/claim': {
        const request = body as ClaimRequest;
        return { kind: 'claim', buyer: request.scope === 'buyer' || request.buckets.includes('buyer'), run: (ctx, report) => service.claim(ctx, request, report) };
      }
      case '/api/rewards/restake': return { kind: 'restake', buyer: false, run: (ctx, report) => service.restake(ctx, body as RestakeRequest, report) };
      case '/api/rewards/stake-usage': return { kind: 'stake-usage', buyer: (body as StakeUsageRequest).side === 'buyer', run: (ctx, report) => service.stakeUsageRewards(ctx, body as StakeUsageRequest, report) };
      case '/api/rewards/compound': return { kind: 'compound', buyer: (body as CompoundRequest).includeBuyer !== false, run: (ctx, report) => service.compound(ctx, body as CompoundRequest, report) };
      case '/api/verification/submit': return { kind: 'verify-submit', buyer: false, run: (ctx, report) => service.submitProof(ctx, (body as SubmitProofRequest).artifact, report) };
      case '/api/seller/register': return { kind: 'seller-register', buyer: false, run: (ctx, report) => service.registerBinding(ctx, (body as { agentId?: number }).agentId, report) };
      case '/api/seller/claim-starter': return { kind: 'claim-starter', buyer: false, run: (ctx, report) => service.claimStarter(ctx, report) };
      default: throw new Error(`Unknown dashboard action: ${path}`);
    }
  }

  private start(action: Action): JobView {
    const wallet = this.wallet;
    if (!wallet) throw new Error('Connect your wallet first.');
    if (this.writeError || this.transactionError) throw new Error(this.writeError ?? this.transactionError);
    if (this.activeJob?.status === 'running') throw new Error('Wait for the previous wallet action.');
    const ctx = this.context;
    const generation = this.generation;
    const validate = async () => {
      if (this.wallet !== wallet || this.generation !== generation) throw new Error('Wallet or buyer changed. Review completed transactions before starting again.');
      if (action.buyer) {
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
    const job = this.jobs.start(action.kind, report => withWalletLock(this.locks, this.chain.evmChainId, wallet, async () => {
      await validate();
      const unresolved = this.activity.transactions(wallet).filter(record => !record.resolved && (record.approvalStarted || record.submittedHash));
      for (const record of unresolved) {
        if (!record.submittedHash || await this.activity.track(ctx.provider(), record) === 'pending') throw new Error('Resolve the previous wallet approval in Account → Transaction recovery before starting another action.');
      }
      try {
        return await action.run(ctx, async (label, hash) => {
          if (hash) try {
            const receipt = await ctx.provider().getTransactionReceipt(hash);
            if (receipt?.status === 1) {
              const ids = receipt.logs.filter(log => log.address.toLowerCase() === this.chain.sellerPoolsAddress?.toLowerCase() && log.topics.length === 4 && log.topics[0] === eventId('Transfer(address,address,uint256)')).map(log => Number(BigInt(log.topics[3]!)));
              if (ids.length) {
                const positions = await ctx.requirePools().positionsBatch([...new Set(ids)]);
                for (const position of positions) if (position.owner.toLowerCase() === wallet.toLowerCase()) ctx.localPositionIds.set(position.id, position.owner);
                this.activity.write(wallet, 'positions', [...ctx.localPositionIds]);
              }
            }
          } catch { await report('Position history could not be saved. Confirmed transactions are still recorded.'); }
          await report(label, hash);
        });
      } finally { ctx.signer = undefined; ctx.invalidate(); }
    }), wallet);
    this.activeJob = job;
    return job;
  }

  async request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    const generation = this.contextGeneration;
    const result = await this.dispatch(path, init);
    if (!init?.method && generation !== this.contextGeneration) throw new Error('Account changed while loading. Refresh this view.');
    return result as T;
  }

  private async dispatch(path: string, init?: { method?: string; body?: unknown }): Promise<unknown> {
    const url = new URL(path, 'https://dashboard.invalid');
    const body = init?.body as Record<string, unknown> | undefined;
    const ctx = this.context;
    if (url.pathname === '/api/config') return this.config();
    if (url.pathname === '/api/wallet') {
      const changed = this.syncWallet(body?.address as string | undefined, body?.chainId as number | undefined, body?.disconnect === true);
      if (body?.refresh) this.context.invalidate();
      return { changed };
    }
    if (url.pathname === '/api/wallet/request') {
      const transaction = this.bridge.request;
      return transaction ? { ...transaction, jobId: this.activeJob?.id } : null;
    }
    if (url.pathname === '/api/wallet/begin') {
      const pending = this.bridge.request;
      if (!pending || this.wallet !== pending.from || ctx.address !== pending.from) throw new Error('Reconnect the original signing wallet.');
      await this.validateAction?.();
      this.bridge.begin(String(body?.id));
      return {};
    }
    if (url.pathname === '/api/wallet/result') {
      const pending = this.bridge.request;
      await this.bridge.complete(String(body?.id), body?.hash as string | undefined, body?.error as string | undefined);
      if (pending && body?.error && !pending.approvalStarted) this.activity.resolve(pending.from, pending.id);
      return {};
    }
    if (url.pathname === '/api/hosted/buyers') {
      if (!this.wallet) return { buyers: [], selected: null, persistent: this.buyers.persistent };
      return { ...this.buyers.load(this.chain.evmChainId, this.wallet), persistent: this.buyers.persistent };
    }
    if (url.pathname === '/api/hosted/buyers/verify') {
      const address = this.buyers.address(String(body?.address));
      return verifyBuyer(address, this.wallet ?? ZeroAddress, async buyer => {
        const deposits = ctx.deposits();
        if (!deposits) throw new Error('Deposits contract is unavailable.');
        ctx.invalidate();
        return deposits.getOperator(buyer);
      });
    }
    if (url.pathname.startsWith('/api/hosted/buyers/')) {
      const wallet = this.assertBuyerChange();
      const address = String(body?.address ?? '');
      const label = String(body?.label ?? '');
      switch (url.pathname) {
        case '/api/hosted/buyers/add': this.buyers.add(this.chain.evmChainId, wallet, address, label); break;
        case '/api/hosted/buyers/select': this.buyers.select(this.chain.evmChainId, wallet, address || null); break;
        case '/api/hosted/buyers/rename': this.buyers.rename(this.chain.evmChainId, wallet, address, label); break;
        case '/api/hosted/buyers/remove': this.buyers.remove(this.chain.evmChainId, wallet, address); break;
        default: throw new Error('Unknown buyer action.');
      }
      this.refreshBuyer();
      return {};
    }
    if (url.pathname === '/api/hosted/recovery') {
      if (!this.wallet) return [];
      const wallet = this.wallet;
      if ((!this.activeJob || this.activeJob.status !== 'running') && this.locks) try {
        await withWalletLock(this.locks, this.chain.evmChainId, wallet, async () => {
          for (const record of this.activity.transactions(wallet).filter(record => !record.resolved && record.submittedHash)) {
            try { await this.activity.track(ctx.provider(), record); } catch {}
          }
        });
      } catch {}
      return this.activity.transactions(this.wallet).filter(record => !record.resolved && (record.approvalStarted || record.submittedHash));
    }
    if (url.pathname === '/api/hosted/recovery/resolve') {
      const wallet = this.assertBuyerChange();
      return withWalletLock(this.locks, this.chain.evmChainId, wallet, async () => {
        const record = this.activity.transactions(wallet).find(entry => entry.id === body?.id);
        if (!record) throw new Error('Unknown approval.');
        if (body?.hash) {
          if (!/^0x[0-9a-fA-F]{64}$/.test(String(body.hash))) throw new Error('Invalid transaction hash.');
          this.activity.record({ ...record, submittedHash: String(body.hash) }, record.buyer);
          record.submittedHash = String(body.hash);
        }
        if (record.submittedHash) return { status: await this.activity.track(ctx.provider(), record) };
        if (body?.confirmedNotSubmitted !== true) throw new Error('Check your wallet and confirm no transaction was submitted.');
        this.activity.resolve(wallet, record.id);
        return { status: 'cleared' };
      });
    }
    if (url.pathname === '/api/jobs') return this.jobs.list(this.wallet ?? ZeroAddress).map(job => ({ ...job, steps: [...job.steps] }));
    if (url.pathname.startsWith('/api/jobs/')) return this.jobs.list(this.wallet ?? ZeroAddress).find(job => job.id === url.pathname.slice('/api/jobs/'.length));
    if (url.pathname === '/api/positions/withdraw/preview') return service.previewWithdraw(ctx, body?.positionIds as number[]);
    if (init?.method === 'POST') return this.start(this.action(url.pathname, body ?? {}));
    switch (url.pathname) {
      case '/api/overview': return service.overview(ctx);
      case '/api/positions': return service.positions(ctx);
      case '/api/rewards': return service.rewards(ctx);
      case '/api/pools': return service.poolsView(ctx);
      case '/api/usage': return service.usage(ctx, { epochs: Number(url.searchParams.get('epochs') ?? 8) });
      case '/api/emissions': return service.emissions(ctx);
      case '/api/verification': return service.verification(ctx, url.searchParams.get('seller') ?? undefined);
      case '/api/seller': return service.seller(ctx);
      default:
        if (url.pathname.startsWith('/api/pools/')) return service.singlePool(ctx, Number(url.pathname.split('/').at(-1)));
        if (url.pathname.startsWith('/api/verification/proofs/')) return service.proofStatus(ctx, decodeURIComponent(url.pathname.split('/').at(-1)!));
        if (/^\/api\/sellers\/[^/]+\/models$/.test(url.pathname)) return sellerModels(this.chain.explorerApiUrl, decodeURIComponent(url.pathname.split('/')[3]!));
        throw new Error(`Unknown dashboard read: ${path}`);
    }
  }
}
