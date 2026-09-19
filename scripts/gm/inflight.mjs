/**
 * In-flight lock (PLAN 2.7): one job per key at a time. A second call with the same key while the first
 * runs gets the first call's result instead of starting its own — a player double-clicking Submit (or a
 * retry after a timeout) can't create two characters. Pure.
 */
export class InFlight {
  #running = new Map();

  /** Is a job running for this key? */
  has(key) {
    return this.#running.has(key);
  }

  /**
   * Run `fn` for `key`, or join the job already running for it.
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  run(key, fn) {
    const running = this.#running.get(key);
    if ( running ) return running;
    const job = Promise.resolve().then(fn).finally(() => this.#running.delete(key));
    this.#running.set(key, job);
    return job;
  }
}
