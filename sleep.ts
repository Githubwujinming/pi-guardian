/**
 * Sleep with optional AbortSignal support.
 * Implements AbortSignal-safe sleep locally since pi-coding-agent's
 * internal sleep utility is not exported as a public API.
 */
export async function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("Canceled");
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new Error("Canceled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function throwIfAborted(signal?: AbortSignal, context?: string): void {
  if (signal?.aborted) {
    throw new Error(context ? `${context} canceled.` : "Canceled");
  }
}

export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.message === "Canceled");
}
