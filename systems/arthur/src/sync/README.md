# src/sync

Phone <-> Home Node synchronization: transactional outbox, idempotent host
receiver, device pairing, and a transport abstraction.

**Status:** boundary only. No protocol, outbox, pairing or transport yet.

## Rules

- May depend on `packages/contracts` and non-frozen shared infrastructure.
- The protocol, service, outbox, host, client and pairing code must **not**
  import a concrete transport (`transport/private_overlay`) or know about
  Tailscale. They see `transport/contracts` only (Repo Structure, Rule 4).
- Must **not** depend on frozen agentic code. Sync is not an Arthur tool and
  does not live in `src/runtime/hybrid`.

Enforced by `tests/architecture/import_boundaries.test.ts`.
