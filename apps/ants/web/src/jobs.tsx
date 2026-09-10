import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { JobView } from '../../src/api-types';
import { api } from './api';
import { invalidateAll } from './data';
import { describeError } from './format';

/*
 * Session transaction state, modelled on Uniswap's transaction UX: a pending
 * pill in the header, an Activity drawer listing this session's jobs, and
 * confirmation toasts as each transaction step lands. The list is polled from
 * `/api/jobs` while the drawer is open or any job is running; toasts are
 * derived by diffing successive polls against what has already been announced.
 */

const POLL_MS = 2000;
const TOAST_MS = 8000;

export type ToastTone = 'success' | 'danger';

export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  /** Free text under the title (error message). */
  body?: string;
  /** Transaction hash rendered as an explorer link under the title. */
  hash?: string;
  /** Sticky toasts stay until dismissed. */
  sticky: boolean;
}

export interface JobsValue {
  /** This session's jobs, newest first. */
  jobs: JobView[];
  /** Number of jobs still running (the server allows one at a time). */
  pending: number;
  running: boolean;
  drawerOpen: boolean;
  pollError: string | null;
  toasts: Toast[];
  setDrawerOpen: (open: boolean) => void;
  dismissToast: (id: number) => void;
  /** POST an action; resolves with the running job (throws on 403/409/other errors). */
  start: (path: string, body: unknown) => Promise<JobView>;
}

const JobsContext = createContext<JobsValue | null>(null);

export function useJobs(): JobsValue {
  const value = useContext(JobsContext);
  if (!value) throw new Error('JobsContext is not mounted');
  return value;
}

const TITLES: Record<string, string> = {
  stake: 'Stake',
  move: 'Move stake',
  split: 'Split position',
  merge: 'Merge positions',
  extend: 'Extend lock',
  'max-lock': 'Max lock',
  withdraw: 'Withdraw',
  claim: 'Claim rewards',
  restake: 'Restake rewards',
  'stake-usage': 'Stake usage rewards',
  'verify-submit': 'Submit proof',
  'seller-register': 'Register seller',
  'claim-starter': 'Claim starter',
};

/** Human title for a job kind ("stake" → "Stake"); unknown kinds are capitalised. */
export function jobTitle(kind: string): string {
  const known = TITLES[kind];
  if (known) return known;
  const words = kind.replace(/[-_]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Transaction';
}

interface Seen {
  hashes: Set<string>;
  terminal: boolean;
}

function sortNewestFirst(jobs: JobView[]): JobView[] {
  return [...jobs].sort((a, b) => b.startedAt - a.startedAt);
}

export function JobsProvider({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [pollError, setPollError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seenRef = useRef(new Map<string, Seen>());
  const toastIdRef = useRef(0);
  const timersRef = useRef(new Map<number, number>());

  const dismissToast = useCallback((id: number) => {
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((list) => list.filter((toast) => toast.id !== id));
  }, []);

  const pushToast = useCallback(
    (toast: Omit<Toast, 'id'>) => {
      const id = ++toastIdRef.current;
      setToasts((list) => [...list, { ...toast, id }]);
      if (!toast.sticky) {
        timersRef.current.set(
          id,
          window.setTimeout(() => dismissToast(id), TOAST_MS),
        );
      }
    },
    [dismissToast],
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);

  /**
   * Merge a fresh job list into state and announce what changed. `silent`
   * (the reload pickup) records existing steps without toasting them, so only
   * steps that complete after reload produce notifications.
   */
  const ingest = useCallback(
    (list: JobView[], silent: boolean) => {
      let finished = false;
      for (const job of list) {
        let seen = seenRef.current.get(job.id);
        if (!seen) {
          seen = { hashes: new Set(), terminal: silent && job.status !== 'running' };
          if (silent) for (const step of job.steps) if (step.hash) seen.hashes.add(step.hash);
          seenRef.current.set(job.id, seen);
        }
        for (const step of job.steps) {
          if (!step.hash || seen.hashes.has(step.hash)) continue;
          seen.hashes.add(step.hash);
          if (!silent) pushToast({ tone: 'success', title: step.label, hash: step.hash, sticky: false });
        }
        if (job.status !== 'running' && !seen.terminal) {
          seen.terminal = true;
          finished = true;
          if (job.status === 'failed') {
            pushToast({ tone: 'danger', title: `${jobTitle(job.kind)} failed`, body: job.error ?? 'The transaction did not complete.', sticky: true });
          } else if (!silent) {
            pushToast({ tone: 'success', title: `${jobTitle(job.kind)} complete`, sticky: false });
          }
        }
      }
      setJobs(sortNewestFirst(list));
      if (finished && !silent) invalidateAll();
    },
    [pushToast],
  );

  const silentRef = useRef(true);
  const refresh = useCallback(async () => {
    // Decide silence up front so an action started while this request is in flight cannot retroactively un-silence it.
    const silent = silentRef.current;
    try {
      const list = await api.jobs();
      ingest(list, silent);
      silentRef.current = false;
      setPollError(null);
    } catch (error) {
      setPollError(describeError(error));
    }
  }, [ingest]);

  // Pick up jobs (and any still-running job) after a page reload.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pending = useMemo(() => jobs.filter((job) => job.status === 'running').length, [jobs]);
  const running = pending > 0;

  // Poll while the drawer is open or anything is in flight; the first fetch is immediate so opening the drawer never shows stale rows.
  useEffect(() => {
    if (!drawerOpen && !running) return;
    let cancelled = false;
    let timer = 0;
    const tick = async () => {
      if (cancelled) return;
      await refresh();
      if (cancelled) return;
      timer = window.setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [drawerOpen, running, refresh]);

  const start = useCallback(async (path: string, body: unknown) => {
    const job = await api.startJob(path, body);
    // A freshly started job is never silent: every hashed step it reports from here on is toasted.
    silentRef.current = false;
    if (!seenRef.current.has(job.id)) seenRef.current.set(job.id, { hashes: new Set(), terminal: false });
    setPollError(null);
    setJobs((list) => sortNewestFirst([job, ...list.filter((item) => item.id !== job.id)]));
    return job;
  }, []);

  const value = useMemo<JobsValue>(
    () => ({ jobs, pending, running, drawerOpen, pollError, toasts, setDrawerOpen, dismissToast, start }),
    [jobs, pending, running, drawerOpen, pollError, toasts, dismissToast, start],
  );

  return <JobsContext.Provider value={value}>{children}</JobsContext.Provider>;
}
