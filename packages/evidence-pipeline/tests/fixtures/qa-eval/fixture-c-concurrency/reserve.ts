export interface SeatStore {
  seats: number;
}

export function createSeatStore(total = 1): SeatStore {
  return { seats: total };
}

export function availableSeats(store: SeatStore): number {
  return store.seats;
}

/**
 * Deliberately defective asynchronous reservation (check-then-act).
 *
 * The defect: availability is read, the task then yields at an explicit
 * barrier, and the write acts on the STALE observation instead of
 * re-checking. Two concurrent callers that both read while one seat
 * remains both succeed, overbooking the single seat (final seats === -1).
 *
 * Invariant (documented, violated here): when only one seat remains, no
 * more than one concurrent reservation may succeed.
 */
export async function reserveSeatDefective(
  store: SeatStore,
  barrier?: {
    notifyRead(): void;
    waitForRelease(): Promise<void>;
  },
): Promise<boolean> {
  const observed = store.seats;
  barrier?.notifyRead();
  if (barrier !== undefined) {
    await barrier.waitForRelease();
  } else {
    await Promise.resolve();
  }
  if (observed <= 0) return false;
  store.seats = observed - 1;
  return true;
}
