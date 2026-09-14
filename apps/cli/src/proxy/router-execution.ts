import type { RouteSelectionContext } from '@antseed/node'

export class RouterExecutionError extends Error {
  constructor(readonly code: 'router_timeout' | 'router_cancelled' | 'router_unavailable' | 'router_invalid_result') {
    super(code)
  }
}

export async function executeRouter<T>(
  select: (context: RouteSelectionContext) => Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  if (signal.aborted) throw new RouterExecutionError('router_cancelled')
  const controller = new AbortController()
  const deadlineMs = Date.now() + timeoutMs
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: () => void = () => {}
  const stop = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      controller.abort()
      reject(new RouterExecutionError('router_cancelled'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => {
      controller.abort()
      reject(new RouterExecutionError('router_timeout'))
    }, timeoutMs)
  })
  try {
    return await Promise.race([stop, Promise.resolve().then(() => select({ signal: controller.signal, deadlineMs }))])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
    controller.abort()
  }
}
