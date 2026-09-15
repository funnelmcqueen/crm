/**
 * FIFO async mutex. PGlite is a single connection and its own query mutex does not stop another
 * caller's statement from landing between our BEGIN and COMMIT, so every request transaction runs
 * inside `run()`.
 */
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  run<T>(task: () => Promise<T>): Promise<T> {
    this.pending += 1;
    const result = this.tail.then(task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result.finally(() => {
      this.pending -= 1;
    });
  }

  get size(): number {
    return this.pending;
  }

  /** Resolves once every task queued so far has settled. */
  async idle(): Promise<void> {
    await this.tail;
  }
}
