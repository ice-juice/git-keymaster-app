/** A revocation boundary for asynchronous plaintext work; never stores secrets. */
export function createSensitiveEpoch() {
  let current = 0;
  const listeners = new Set<() => void>();
  return {
    snapshot: () => current,
    isCurrent: (epoch: number) => epoch === current,
    invalidate() {
      current += 1;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
