# src/devices

Arthur-side hardware integration (software only). `hardware/emg` is the physical
hardware, PCB and firmware; `src/devices/emg` will be the software integration.

**Status:** boundary only. No registry or EMG integration yet.

## Rules

- May depend on `packages/contracts` and non-frozen shared infrastructure.
- Must **not** depend on `src/cognitive`. Devices emit capture/intent events;
  they never write knowledge directly (Repo Structure, Rule 3).
- Must **not** be exposed as a generic Arthur tool or depend on frozen agentic
  code.

Enforced by `tests/architecture/import_boundaries.test.ts`.
