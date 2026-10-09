# A.R.T.H.U.R. Cognitive Runtime — Repository Structure & Freeze Policy

**Status:** Architecture freeze  
**Date:** 1 October 2026  
**Target:** John Atanasov Tournament / A.R.T.H.U.R. Cognitive Runtime v1

---

## 1. Purpose

This document defines how the existing A.R.T.H.U.R. repository should be reorganized conceptually for the new Cognitive Runtime direction without deleting or destabilizing the already implemented agentic/runtime functionality.

The goal is to create a clear boundary between:

- the **new competition-critical Cognitive Runtime**;
- the **existing reusable platform infrastructure**;
- the **frozen agentic features** that remain in the repository but are not part of the John Atanasov critical path.

The core rule is:

> **Freeze old non-critical functionality. Do not delete or rewrite it. Build the new Arthur as new top-level product domains on top of the stable infrastructure that already exists.**

---

## 2. Repository Top-Level Structure

```text
A.R.T.H.U.R/
│
├── apps/               # Product surfaces
├── packages/           # Shared cross-platform contracts/protocols
├── src/                # Arthur Core
├── hardware/           # EMG hardware/firmware/PCB
├── tests/              # Runtime + cognitive + sync + device tests
└── docs/               # Architecture and competition scope
```

---

## 3. Product Applications

```text
apps/
├── api/                    # EXISTING — Home Node/API surface
├── cli/                    # EXISTING — maintenance/debug/admin tooling
│
└── arthur/                 # NEW — main Tauri product application
    ├── src/                # React/TypeScript shared UI
    └── src-tauri/          # Rust/Tauri native/platform layer
```

### 3.1 `apps/api/`

Keep the existing API surface and adapt it where useful for the Home Node.

Responsibilities may include:

- sessions;
- Home Node API;
- Cognitive Core endpoints;
- sync endpoints;
- realtime events;
- model access;
- device status.

Do not rebuild the API layer from scratch unless an existing boundary is fundamentally incompatible with the Cognitive Runtime.

### 3.2 `apps/cli/`

The CLI remains useful for:

- debugging;
- acceptance tests;
- diagnostics;
- developer configuration;
- recovery/admin operations.

The CLI is **not** a competition product surface and should receive only maintenance work unless required by the new runtime.

### 3.3 `apps/arthur/`

This becomes the single primary Arthur application for:

- Windows;
- Linux;
- Android;
- later macOS/iOS.

Suggested structure:

```text
apps/arthur/
│
├── src/
│   ├── app/
│   │   ├── router.tsx
│   │   ├── providers.tsx
│   │   └── layout.tsx
│   │
│   ├── features/
│   │   ├── capture/
│   │   ├── inbox/
│   │   ├── ideas/
│   │   ├── projects/
│   │   ├── tasks/
│   │   ├── graph/
│   │   ├── lineage/
│   │   ├── recall/
│   │   ├── devices/
│   │   └── settings/
│   │
│   ├── components/
│   │   ├── ui/
│   │   └── arthur/
│   │
│   ├── client/
│   │   ├── arthur-client.ts
│   │   ├── desktop-client.ts
│   │   └── mobile-client.ts
│   │
│   ├── stores/
│   ├── hooks/
│   └── lib/
│
└── src-tauri/
    ├── src/
    │   ├── commands/
    │   ├── platform/
    │   ├── storage/
    │   ├── audio/
    │   ├── devices/
    │   └── main.rs
    │
    ├── capabilities/
    └── tauri.conf.json
```

The frontend should never directly depend on platform-specific implementation details.

---

## 4. Shared Packages

```text
packages/
├── contracts/                 # Shared pure TypeScript data contracts
└── protocol/                  # Shared sync/device protocol contracts
```

### 4.1 `packages/contracts/`

Suggested files:

```text
packages/contracts/
├── capture.ts
├── cognitive.ts
├── sync.ts
├── devices.ts
└── api.ts
```

These packages must remain free of:

- React;
- Tauri;
- Rust;
- database access;
- Node-specific runtime dependencies.

They define the common language between:

- desktop UI;
- mobile UI;
- Home Node;
- API;
- sync protocol;
- tests.

Example:

```ts
export interface KnowledgeObject {
  id: string;
  kind: "idea" | "task" | "decision" | "question" | "note";
  title: string;
  body: string;
  createdAt: string;
}
```

---

## 5. New Core Domains

The new Cognitive Runtime should be built as new top-level domains rather than inserted into legacy agentic subsystems.

```text
src/
├── capture/                   # NEW
├── cognitive/                 # NEW
├── sync/                      # NEW
└── devices/                   # NEW
```

---

## 6. `src/capture/`

Capture is an input primitive and should remain separate from cognition.

```text
src/capture/
├── contracts.ts
├── service.ts
├── transcript.ts
├── queue.ts
└── sources/
    ├── text.ts
    ├── voice.ts
    └── emg.ts
```

All input mechanisms eventually produce the same logical object:

```text
Text ───┐
Voice ──┼──→ CaptureService → Capture
EMG ────┘
```

This prevents EMG, voice, or UI code from depending directly on Ideas, Graph, or Lineage.

---

## 7. `src/cognitive/`

This becomes the primary new Arthur subsystem.

```text
src/cognitive/
│
├── contracts.ts
├── service.ts
│
├── store/
│   ├── contracts.ts
│   ├── sqlite_store.ts
│   └── migrations.ts
│
├── distillation/
│   ├── schemas.ts
│   ├── prompts.ts
│   ├── extractor.ts
│   └── service.ts
│
├── provenance/
│   ├── contracts.ts
│   └── service.ts
│
├── index/
│   └── memory_projection.ts
│
├── graph/
│   ├── contracts.ts
│   ├── candidate_retriever.ts
│   ├── classifier.ts
│   └── service.ts
│
├── lineage/
│   ├── contracts.ts
│   ├── revision_store.ts
│   ├── diff.ts
│   └── service.ts
│
└── recall/
    ├── planner.ts
    ├── evidence_builder.ts
    └── service.ts
```

### Architectural rule

`src/cognitive/` must not depend on legacy agentic functionality such as:

- app launching;
- filesystem executors;
- Git tools;
- browser tools;
- generic tool orchestration.

If the entire agentic layer were disabled, Cognitive Core must still work.

---

## 8. `src/sync/`

Phone ↔ Home Node synchronization is its own subsystem.

```text
src/sync/
│
├── contracts.ts
├── protocol.ts
├── service.ts
│
├── outbox/
│   ├── store.ts
│   └── worker.ts
│
├── host/
│   ├── receiver.ts
│   └── acknowledgements.ts
│
├── client/
│   └── sync_client.ts
│
├── pairing/
│   ├── contracts.ts
│   ├── qr.ts
│   └── identity.ts
│
└── transport/
    ├── contracts.ts
    └── private_overlay.ts
```

The sync protocol must be independent from the selected transport.

```text
Cognitive Store
      ↑
Sync Service
      ↑
Transport abstraction
      ↑
Tailscale / private overlay
```

Competition v1 can use a private-overlay transport while preserving the possibility of future:

- LAN transport;
- Arthur P2P transport;
- Arthur relay transport.

---

## 9. `src/devices/`

Arthur hardware integration belongs here.

```text
src/devices/
├── contracts.ts
├── registry.ts
└── emg/
    ├── contracts.ts
    ├── gestures.ts
    ├── calibration.ts
    └── service.ts
```

This folder contains Arthur-side device integration, not PCB or firmware files.

The distinction is:

```text
hardware/emg/
= physical hardware + PCB + firmware

src/devices/emg/
= Arthur software integration
```

---

## 10. Existing Memory Layer

```text
src/memory/
```

The memory system is **not legacy** and should not be frozen.

Its role changes.

### Old model

```text
Memory
= source of truth
```

### New model

```text
Cognitive Store
= source of truth

Memory/RAG
= semantic projection / retrieval index
```

The dependency direction should therefore be:

```text
src/cognitive/index/
        ↓
src/memory/
```

Not:

```text
src/memory/
   ↓ owns
Ideas / Tasks / Decisions
```

Do not force the new Cognitive Object model into the existing `memory_items` schema.

---

## 11. Existing Reusable Infrastructure

The following existing areas remain active infrastructure and can be reused:

```text
src/models/
src/sessions/
src/memory/
src/security/
src/observability/
src/voice/        # selectively adapt/reuse
src/runtime/      # selectively reuse
```

Examples of reusable systems:

- ModelGateway;
- cloud providers;
- sessions;
- SQLite patterns;
- memory/RAG;
- embeddings interfaces;
- HTTP API;
- realtime event patterns;
- sanitization;
- observability;
- ArthurNode concepts;
- capability routing concepts.

---

## 12. Frozen Agentic Features

The following features remain in the repository but are outside the John Atanasov critical path.

They should receive only regression fixes unless a Cognitive Runtime dependency genuinely requires them.

```text
src/tools/**
application launching/control
filesystem action expansion
browser actions
Git tool expansion
generic tool execution improvements
approval/execution feature expansion
remote tool execution expansion
generic autonomous agent functionality
```

Do **not** move them into a new `legacy/` or `frozen/` directory.

Moving large amounts of stable code would create unnecessary churn and regression risk.

Instead document the freeze explicitly.

Suggested document:

```text
docs/competition/FROZEN_SUBSYSTEMS.md
```

Core rule:

> Existing tests must remain green, but no new functionality should be added to frozen subsystems unless required by the Cognitive Runtime.

---

## 13. Partial Freeze of `src/runtime/`

The entire runtime folder must not be frozen because useful platform concepts already exist there.

### Keep / reuse

```text
ArthurNode
NodeRegistry
cloud model routing
provider contracts
runtime capabilities
selected LAN/runtime abstractions
```

### Freeze for competition

```text
local model platform expansion
remote tool execution expansion
generic agentic routing expansion
```

Freeze is therefore **feature-level**, not necessarily folder-level.

---

## 14. Voice Layer

`src/voice/` remains useful but should be adapted carefully.

Reuse:

- STT/TTS contracts;
- voice state patterns;
- realtime events;
- cloud voice providers;
- conversation/capture integration concepts.

Freeze:

- new local STT/TTS expansion;
- new local voice model installation work;
- unrelated desktop-only voice infrastructure improvements.

For the competition product, cloud models are preferred and the mobile platform receives its own native microphone integration through Tauri/Kotlin.

---

## 15. Test Structure

```text
tests/
├── capture/                      NEW
├── cognitive/                    NEW
├── sync/                         NEW
├── devices/                      NEW
│
├── memory/                       EXISTING
├── voice/                        EXISTING
├── runtime/                      EXISTING
└── tools/                        EXISTING — regression only
```

Competition-critical tests should focus on vertical flows such as:

```text
capture
→ cloud interpretation
→ local persistence
→ outbox
→ Home Node sync
→ Cognitive Store
→ semantic index
→ Graph
→ Recall
```

Frozen subsystems retain their existing regression coverage.

---

## 16. Documentation Structure

```text
docs/
├── architecture/
│   ├── ARTHUR_Cognitive_Runtime_v1.md
│   └── ARTHUR_Cognitive_Runtime_Repo_Structure.md
│
└── competition/
    ├── JOHN_ATANASOV_SCOPE.md
    └── FROZEN_SUBSYSTEMS.md
```

---

## 17. Final Target Repository Tree

```text
A.R.T.H.U.R/
│
├── apps/
│   ├── api/                       EXISTING / KEEP
│   ├── cli/                       EXISTING / MAINTENANCE
│   └── arthur/                    NEW
│       ├── src/
│       │   ├── app/
│       │   ├── features/
│       │   ├── components/
│       │   ├── client/
│       │   └── stores/
│       └── src-tauri/
│
├── packages/
│   ├── contracts/                 NEW
│   └── protocol/                  NEW
│
├── src/
│   ├── capture/                   NEW
│   ├── cognitive/                 NEW
│   │   ├── store/
│   │   ├── provenance/
│   │   ├── distillation/
│   │   ├── index/
│   │   ├── graph/
│   │   ├── lineage/
│   │   └── recall/
│   │
│   ├── sync/                      NEW
│   ├── devices/                   NEW
│   │   └── emg/
│   │
│   ├── memory/                    KEEP / REUSE
│   ├── models/                    KEEP / REUSE
│   ├── sessions/                  KEEP / REUSE
│   ├── voice/                     KEEP / ADAPT
│   ├── security/                  KEEP / REUSE
│   ├── observability/             KEEP / REUSE
│   ├── runtime/                   PARTIAL FREEZE
│   └── tools/                     FROZEN
│
├── hardware/
│   └── emg/                       EXISTING
│
├── tests/
│   ├── capture/                   NEW
│   ├── cognitive/                 NEW
│   ├── sync/                      NEW
│   ├── devices/                   NEW
│   ├── memory/                    EXISTING
│   ├── voice/                     EXISTING
│   └── tools/                     EXISTING / REGRESSION ONLY
│
└── docs/
    ├── architecture/
    │   ├── ARTHUR_Cognitive_Runtime_v1.md
    │   └── ARTHUR_Cognitive_Runtime_Repo_Structure.md
    │
    └── competition/
        ├── JOHN_ATANASOV_SCOPE.md
        └── FROZEN_SUBSYSTEMS.md
```

---

## 18. Hard Architecture Rules

### Rule 1 — New features do not enter frozen subsystems by convenience

> **New competition features must not be implemented inside frozen agentic subsystems merely because convenient code already exists there.**

Examples:

```text
Home Node sync
❌ src/runtime/hybrid/tool_protocol.ts
✅ src/sync/
```

```text
EMG
❌ generic Arthur tool
✅ src/devices/emg/
```

```text
Ideas
❌ memory_items as the authoritative model
✅ src/cognitive/store/
```

---

### Rule 2 — Cognitive Store is authoritative

The Cognitive Store owns:

- ideas;
- tasks;
- decisions;
- questions;
- projects;
- relations;
- revisions;
- provenance.

Memory/RAG owns semantic retrieval projections only.

---

### Rule 3 — Capture is platform-independent

Voice, text and EMG all terminate at the same Capture abstraction.

No input source should directly manipulate the Cognitive Graph or Cognitive Store.

---

### Rule 4 — Sync is transport-independent

The sync protocol must not know or care whether connectivity comes from:

- Tailscale;
- LAN;
- future Arthur P2P;
- future relay.

---

### Rule 5 — Product UI talks through `ArthurClient`

React components must not directly talk to:

- localhost HTTP implementation details;
- Tailscale addresses;
- SQLite implementation details;
- Android native APIs;
- Node processes.

They communicate through a stable client abstraction.

---

### Rule 6 — No rewrite of stable Arthur infrastructure without necessity

Existing stable TypeScript systems should be reused through explicit boundaries.

Tauri/Rust adoption does not justify rewriting the current Arthur Core.

---

## 19. Competition Development Principle

The competition branch should optimize for one vertical path:

```text
Tauri
  ↓
Android capture
  ↓
Cloud AI
  ↓
Local persistence
  ↓
Home Node sync
  ↓
Cognitive Store
  ↓
Provenance
  ↓
Semantic retrieval
  ↓
Cognitive Graph
  ↓
Thought Lineage
  ↓
Cognitive Recall
  ↓
EMG integration
```

Everything outside this path is maintenance-only until after John Atanasov.

---

## 20. Final Principle

> **The existing Arthur becomes the stable platform foundation. The new Cognitive Runtime is built as a set of clean top-level domains rather than as extensions of the old agentic feature tree.**

This keeps the project understandable, reduces regression risk, protects already completed work, and allows the agentic layer to be reintroduced later as **Arthur Actions** on top of the Cognitive Runtime rather than competing with it during the tournament development cycle.
