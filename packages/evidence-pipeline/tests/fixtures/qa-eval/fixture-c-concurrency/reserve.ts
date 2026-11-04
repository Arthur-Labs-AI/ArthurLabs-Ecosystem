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
 * Seat reservation service.
 *
 * Intended invariant: when only one seat remains, no more than one
 * concurrent reservation may succeed.
 *
 * The optional `barrier` is a deterministic scheduling hook used by
 * concurrency tests to interleave overlapping calls reproducibly.
 */
export async function reserveSeat(
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
