/**
 * Sync domain: public entry point.
 *
 * Boundary only (M01A). Phone <-> Home Node synchronization (outbox, host
 * receiver, pairing) is not implemented. The protocol must stay independent of
 * the transport; only `transport/contracts` is visible above the transport layer.
 * See README.md for the dependency rules enforced by tests/architecture.
 */
export {};
