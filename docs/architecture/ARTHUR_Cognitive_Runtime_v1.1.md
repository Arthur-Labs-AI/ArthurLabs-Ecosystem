# A.R.T.H.U.R. Cognitive Runtime
## Architecture & Product Direction v1.1

**Status:** Architecture direction freeze  
**Date:** 1 October 2026  
**Target:** John Atanasov Tournament + long-term Arthur architecture

---

# 1. Product Vision

A.R.T.H.U.R. is transitioning from a broad personal/business agent capable of controlling applications and tools into a **personal cognitive system**.

The central problem Arthur solves is:

> Human thoughts appear faster than people can properly capture, organize, connect and retrieve them.

Arthur captures thoughts through natural interfaces such as voice and EMG gestures, converts them into structured knowledge, connects them with previous thoughts, preserves how ideas evolve, and allows the user to recall this knowledge later.

The core flow is:

```text
Unstructured human thought
        ↓
Capture
        ↓
AI interpretation
        ↓
Structured knowledge
        ↓
Connected knowledge
        ↓
Evolving personal knowledge
        ↓
Recall / Action
```

Arthur is therefore not intended to be merely an AI notes application or an Obsidian clone.

Its long-term identity is:

> **A personal cognitive operating layer that captures, structures, connects and reconstructs human knowledge across devices.**

---

# 2. Core Architecture Principles

## 2.1 Cloud AI, Local Knowledge

For the competition version, all AI models are cloud models.

```text
STT       → Cloud
LLM       → Cloud
TTS       → Cloud
```

Arthur does **not** require an Arthur-owned cloud database or mandatory Arthur cloud server.

Persistent user knowledge remains local.

```text
Ideas              → Local
Memory             → Local
Cognitive Graph    → Local
Thought Lineage    → Local
Tasks              → Local
Documents          → Local
Projects           → Local
Sync queues        → Local
```

Cloud AI may temporarily receive the content required to process a request, but the canonical Arthur knowledge base is not hosted in an Arthur cloud service.

The principle is:

> **Cloud intelligence, locally owned knowledge.**

---

# 3. Device Philosophy

Arthur is a multi-device system.

Different devices should perform the work appropriate for their capabilities.

The long-term rule is:

> **Do the work on the weakest available device that can perform it well; escalate heavier workloads to a more capable Arthur node.**

For the competition version this routing remains intentionally simple and deterministic.

---

# 4. Arthur Mobile

The phone is the primary **capture device**.

Arthur Mobile is built using **Tauri v2**, sharing the application UI architecture with Windows, Linux and later macOS/iOS.

The phone is not merely a remote control.

It is a real Arthur node capable of performing lightweight cognitive operations.

Primary responsibilities:

```text
Voice capture
Text capture
Cloud STT
Cloud TTS
Cloud LLM requests
Basic thought structuring
Local temporary storage
Sync outbox
Basic search/cache
BLE communication
EMG interaction
```

Example:

```text
User thought
    ↓
EMG gesture / button
    ↓
Phone microphone
    ↓
Cloud STT
    ↓
Transcript
    ↓
Cloud LLM
    ↓
Structured Idea + Tasks + Metadata
    ↓
Local phone storage
```

The phone remains useful even when the user's PC is powered off.

---

# 5. Arthur Home Node

The user's computer acts as the **Arthur Home Node**.

Initially this means Windows and Linux.

The Home Node owns the canonical cognitive knowledge base.

```text
Arthur Home Node
│
├── Cognitive Store
├── Ideas
├── Projects
├── Tasks
├── Decisions
├── Cognitive Graph
├── Thought Lineage
├── Semantic Index
├── Documents
├── Cognitive Recall
├── Nexus integration
└── Device synchronization
```

The computer performs heavier cognitive workloads such as:

```text
Cross-project semantic retrieval
Large knowledge searches
Cognitive Graph construction
Conflict analysis
Thought Lineage reconstruction
Deep Recall
Large document processing
Nexus workloads
Sentry workloads
```

The Home Node is **not required for capturing thoughts**.

---

# 6. Phone ↔ Home Node Synchronization

Arthur uses a **local-first synchronization architecture**.

The phone always writes captures locally first.

When the Home Node is reachable:

```text
Phone
  ↓
new capture
  ↓
local save
  ↓
Home Node reachable
  ↓
authenticated sync
  ↓
Home Node commit
  ↓
ACK
  ↓
phone marks item synchronized
```

When the Home Node is unavailable:

```text
Phone
  ↓
new capture
  ↓
local save
  ↓
sync outbox
  ↓
Home Node unavailable
  ↓
retain locally
  ↓
retry later
```

When the PC becomes available again, synchronization resumes automatically.

No idea should ever depend on connectivity to survive.

---

# 7. Sync Reliability

The phone uses a transactional outbox.

Conceptually:

```text
captures
---------
capture_id
content
created_at
sync_state

sync_outbox
-----------
event_id
entity_id
operation
payload_hash
created_at
attempt_count
state
```

Creating a capture and creating its sync event happen atomically.

Synchronization must be idempotent.

Example failure:

```text
Phone sends capture-123
        ↓
PC stores capture-123
        ↓
connection dies before ACK
        ↓
Phone retries
        ↓
PC recognizes event already committed
        ↓
ACK
```

No duplicate Idea is created.

The Home Node is authoritative for canonical cognitive state.

The phone acts as:

```text
Capture device
Local cache
Temporary knowledge store
Sync client
```

The Home Node acts as:

```text
Canonical knowledge authority
Graph authority
Lineage authority
Full retrieval authority
```

This deliberately avoids multi-master synchronization complexity during the competition phase.

---

# 8. Device Pairing

Pairing and network connectivity are separate concerns.

A device may be cryptographically paired even when the phone and Home Node are not currently on the same network.

Suggested pairing flow:

```text
Desktop:
Arthur → Devices → Add Device
        ↓
QR code generated

Phone:
Scan QR
        ↓
verify pairing information
        ↓
establish trusted device relationship
```

The QR payload can contain:

```text
home_node_id
home_node_public_key
one_time_pairing_secret
protocol_version
```

The phone generates or already possesses its own device identity.

After pairing, both nodes store only the information required to recognize each other securely.

Example trusted relationship:

```text
Home Node
├── device_id: desktop-main
├── public_key: ...
└── paired_device:
      ├── phone-s22
      └── public_key: ...

Phone
├── device_id: phone-s22
├── public_key: ...
└── trusted_home_node:
      ├── desktop-main
      └── public_key: ...
```

Pairing establishes **identity and trust**.

It does not itself provide network connectivity.

---

# 9. Remote Connectivity

## 9.1 Competition Decision

For John Atanasov v1, Arthur will use a **private overlay network**, such as Tailscale/WireGuard-style connectivity, between trusted devices.

This allows the phone and Home Node to communicate even when they are on different physical networks.

Example:

```text
Phone
5G / school Wi-Fi
        │
        │ encrypted private overlay
        │
        ▼
Home Node
home Wi-Fi
```

The devices can therefore synchronize when:

```text
Phone → mobile network
PC    → home internet
```

or:

```text
Phone → external Wi-Fi
PC    → different external/home network
```

without requiring an Arthur-owned cloud sync server.

---

## 9.2 Network Trust Is Not Arthur Trust

The private overlay is used only as a **transport layer**.

Arthur does not automatically trust every device reachable through the private network.

The security model is:

```text
Network connection available
        ↓
Arthur device authentication
        ↓
Is this device explicitly paired?
        │
     ┌──┴──┐
     │     │
    NO    YES
     │     │
 reject   continue
           ↓
      authenticated sync
```

Therefore:

```text
Tailscale / WireGuard
= connectivity

Arthur Pairing
= identity + authorization
```

These responsibilities must remain separate.

---

## 9.3 Transport Abstraction

The Cognitive Core and Sync Engine must not depend directly on Tailscale.

Arthur should expose a transport abstraction such as:

```text
HomeNodeTransport
│
├── discover()
├── connect()
├── send()
└── disconnect()
```

Competition implementation:

```text
PrivateOverlayTransport
```

Possible future implementations:

```text
LanTransport
ArthurP2PTransport
ArthurRelayTransport
```

The synchronization protocol above this layer remains unchanged.

---

## 9.4 Competition Network Architecture

The resulting architecture is:

```text
                 CLOUD AI PROVIDERS
               STT / LLM / TTS
                      ▲
                      │
              transient requests
                      │

PHONE                                    HOME NODE
Tauri / Android                          Tauri / PC
┌──────────────────┐                    ┌──────────────────────┐
│ Voice/Text       │                    │ Cognitive Store      │
│ Cloud AI client  │                    │ Cognitive Graph      │
│ Local SQLite     │                    │ Thought Lineage      │
│ Sync Outbox      │                    │ Cognitive Recall     │
│ BLE / EMG        │                    │ Documents            │
└────────┬─────────┘                    └──────────▲───────────┘
         │                                         │
         └════ Private encrypted overlay ═════════┘
                    +
             Arthur authentication
```

No Arthur-owned cloud database is required.

No Arthur-owned public relay is required for competition v1.

---

## 9.5 Failure Behaviour

If the Home Node is powered off:

```text
capture
 ↓
local phone DB
 ↓
outbox
 ↓
retry later
```

If the private overlay is temporarily unavailable:

```text
capture
 ↓
local phone DB
 ↓
outbox
 ↓
retry later
```

If the phone has internet access but Home Node does not:

```text
Cloud AI processing can continue
        ↓
result remains local
        ↓
sync waits
```

The user's ability to capture ideas is therefore independent from Home Node availability.

---

# 10. Shared Tauri Application

Arthur will use **Tauri v2** as the cross-platform application shell.

Target architecture:

```text
                 Arthur UI
             React / TypeScript
                    │
                 Tauri v2
                    │
        ┌───────────┼───────────┐
        │           │           │
      Linux       Windows     Android
```

Later:

```text
macOS
iOS
```

The frontend remains shared.

Platform-specific functionality lives behind Tauri commands/plugins.

Example:

```text
UI
 ↓
capture.start()
 ↓
Tauri platform layer
 ├── Android native microphone
 └── Desktop microphone
```

The same concept applies to BLE and EMG.

---

# 11. Existing Arthur Core

The existing Arthur codebase is not discarded.

Major reusable foundations already include:

```text
ModelGateway
Cloud providers
Sessions
SQLite persistence
Memory/RAG
Hybrid retrieval
Embeddings interface
Voice state machine
STT/TTS abstractions
HTTP API
Realtime WebSocket
Security boundaries
Sanitization
Observability
Hybrid runtime
ArthurNode abstraction
NodeRegistry
Capability routing concepts
```

These components become infrastructure underneath the new Arthur product.

---

# 12. Legacy Agentic Functionality

The existing agentic capabilities are **frozen, not deleted**.

Examples:

```text
system.*
application launching
filesystem tools
browser tools
Git tools
remote tool execution
approval lifecycle
generic application control
```

These are no longer part of the competition critical path.

They become an optional future layer:

> **Arthur Actions**

Long-term:

```text
Thought
 ↓
Idea
 ↓
Plan
 ↓
Task
 ↓
Arthur Action
 ↓
Nexus executes
 ↓
Sentry verifies
```

Therefore previous work remains valuable without distracting the current product.

---

# 13. Cognitive Core

The new primary Arthur subsystem is the **Cognitive Core**.

Conceptual modules:

```text
src/cognitive/

capture/
distillation/
store/
index/
graph/
lineage/
recall/
```

It is separate from the existing `src/memory/` implementation.

The existing memory system becomes a retrieval/indexing layer, not the authoritative representation of ideas.

---

# 14. Knowledge Object Model

Arthur does not store everything as a generic note.

A capture may generate several structured knowledge objects.

Core types:

```text
Idea
Task
Decision
Question
Note
```

Conceptual structure:

```text
KnowledgeObject
│
├── id
├── kind
├── title
├── body
├── project
├── tags
├── status
├── created_at
├── updated_at
├── source
└── current_revision
```

One voice recording may therefore produce:

```text
1 Idea
2 Tasks
1 Decision
1 Open Question
```

---

# 15. Provenance-Preserving Capture

Arthur must preserve the distinction between:

```text
What the human said
What AI interpreted
What AI derived
```

Three conceptual levels:

```text
RAW
 ↓
INTERPRETED
 ↓
DERIVED
```

For competition v1, the authoritative raw source is primarily the **original transcript**, not persisted microphone audio.

This preserves the existing Arthur privacy property that raw PCM audio is not permanently stored.

A derived object stores its origin:

```text
Task:
"Benchmark EMG latency"

source_capture: cap-481
source_span: 184..236
```

The UI can therefore expose:

> View original source

This makes AI transformations auditable.

---

# 16. Cognitive Distillation

A capture enters the Cognitive Distillation Engine.

```text
Capture
   ↓
Transcript normalization
   ↓
Thought segmentation
   ↓
Structured extraction
   ↓
Idea / Task / Decision / Question
   ↓
Metadata
```

The existing `MemoryExtractor` architecture provides a useful foundation:

```text
ModelGateway
+
strict structured output
+
Zod validation
+
fail-closed malformed responses
```

Cognitive extraction must use the same philosophy.

The model never writes arbitrary data directly to the database.

---

# 17. Cognitive Graph

Arthur builds a graph of knowledge rather than merely maintaining backlinks.

Nodes represent knowledge objects.

Edges have meaning.

```text
Idea A
 ├── RELATED_TO ───→ Idea B
 ├── EXTENDS ──────→ Idea C
 ├── DEPENDS_ON ───→ Task D
 ├── CONTRADICTS ──→ Decision E
 ├── DUPLICATES ───→ Idea F
 └── DERIVED_FROM ─→ Capture G
```

Suggested initial relationship taxonomy:

```text
RELATED
EXTENDS
DEPENDS_ON
DUPLICATES
CONTRADICTS
SUPERSEDES
DERIVED_FROM
```

Graph construction should use:

```text
new object
   ↓
semantic retrieval
   ↓
Top-K candidates
   ↓
constrained relation classifier
   ↓
validated relationships
   ↓
graph persistence
```

The LLM does not compare every object with every other object.

Semantic retrieval limits the candidate set.

---

# 18. Semantic Retrieval Upgrade

The current Arthur `LocalMultilingualEmbeddingProvider` uses deterministic character n-gram hashing.

This is useful as a lightweight/offline fallback but its quality is intentionally limited.

The flagship Cognitive Graph should eventually use a stronger multilingual embedding provider.

Before selecting one, Arthur should have a benchmark dataset covering:

```text
RELATED
UNRELATED
DUPLICATE
EXTENDS
CONTRADICTS
```

Embedding quality must be measurable rather than assumed.

---

# 19. Thought Lineage

Arthur treats ideas as evolving concepts rather than mutable files.

An idea has history.

```text
Initial Thought
      │
      ▼
Revision 1
   ┌──┴──┐
   ▼     ▼
Rev 2A  Rev 2B
   └──┬──┘
      ▼
   Rev 3
```

The data model is a DAG.

A revision may have one parent.

A merge revision may have multiple parents.

Arthur can then answer:

> How did my idea for the EMG interface evolve?

The system retrieves the lineage chronologically and produces a semantic change summary.

Example:

```text
Sep 12
4 gestures planned.

Sep 18
Reduced to 2 gestures.

Reason:
Reliability was prioritized.

Sep 25
Added vibration confirmation.

Oct 1
EMG became primarily an Idea Capture interface.
```

This is the basis of the **Thought Lineage Engine**.

---

# 20. Semantic Conflict Detection

When a new object is created, Arthur can compare it with relevant previous decisions and ideas.

Example:

```text
New:
"Use ESP32-S3"

Existing Decision:
"Use nRF52840 because of power consumption."
```

Arthur surfaces:

```text
Potential contradiction detected
```

It does not decide which option is correct.

Its role is to surface cognitive inconsistency.

---

# 21. Idea Fusion

Arthur can also recognize when several independent thoughts are actually parts of a larger concept.

Example:

```text
Automatic model discovery
+
Price comparison
+
Migration popup
```

may form:

```text
Automatic Model Lifecycle Manager
```

Arthur can propose a parent concept while retaining the original source ideas.

---

# 22. Cognitive Recall

Arthur Recall is more than normal vector RAG.

Traditional retrieval:

```text
Question
 ↓
Vector search
 ↓
LLM
```

Arthur Cognitive Recall:

```text
Question
    ↓
Query Intent
    ↓
┌─────────────────────────┐
│ Semantic Retrieval      │
│ Graph Traversal         │
│ Thought Lineage         │
│ Temporal Ordering       │
│ Decisions               │
│ Source Provenance       │
└─────────────────────────┘
    ↓
Evidence Bundle
    ↓
Cloud LLM
    ↓
Answer + Sources
```

Different queries require different retrieval plans.

Examples:

```text
"What ideas do I have about EMG?"
→ semantic retrieval

"How did my EMG idea change?"
→ lineage traversal

"What conflicts exist in the Nexus plan?"
→ contradiction edges

"What is the current state of Arthur?"
→ projects + decisions + tasks + chronology
```

This becomes a **query planner for personal knowledge**.

---

# 23. EMG Intent Interface

The EMG wristband is not a thought-reading device.

It detects muscular activity and classifies deliberate gestures.

Conceptual pipeline:

```text
EMG electrodes
      ↓
AFE / ADC
      ↓
signal processing
      ↓
feature extraction
      ↓
personalized classifier
      ↓
confidence threshold
      ↓
temporal confirmation
      ↓
Intent Event
```

Competition v1 should prioritize reliability over gesture count.

Primary intents:

```text
CAPTURE_START
CAPTURE_STOP
```

Potential event contract:

```text
GestureEvent
{
  device_id
  gesture_id
  confidence
  duration_ms
  timestamp
}
```

The phone receives the BLE event and converts it to a semantic Arthur action.

```text
EMG
 ↓ BLE
Phone
 ↓
CAPTURE_START
 ↓
voice capture
```

Raw EMG processing is isolated from Cognitive Core.

---

# 24. Competition Device Responsibilities

For John Atanasov the distribution is intentionally simple.

## Phone

```text
Voice/Text Capture
Cloud STT
Cloud TTS
Cloud LLM Distillation
Local Capture DB
Local Sync Outbox
Basic UI
Private-overlay connectivity
BLE
EMG
```

## Home Node

```text
Canonical Cognitive Store
Cognitive Graph
Thought Lineage
Deep Cognitive Recall
Documents
Full semantic retrieval
Device synchronization
Private-overlay endpoint
Nexus integration
Sentry integration
```

No generic distributed scheduler is required before the competition.

---

# 25. Long-Term Device-Aware Runtime

After the competition, the simple Phone/Home Node model can evolve into capability-aware execution.

Example capabilities:

```text
capture.voice
speech.transcribe
speech.synthesize
cognitive.distill
cognitive.search
cognitive.graph.update
cognitive.lineage.analyze
cognitive.recall
document.analyze
bluetooth.emg
```

Possible future nodes:

```text
Phone
Laptop
Desktop
Arthur Box
Server
```

Arthur can then route workloads based on available capabilities.

The existing `ArthurNode`, `NodeRegistry`, `runtime_capabilities` and hybrid routing concepts provide architectural foundations for this future.

---

# 26. Product Surface

The shared Tauri application eventually exposes:

```text
Inbox
Ideas
Projects
Tasks
Decisions
Questions
Graph
Timeline
Ask Arthur
Capture
Devices
```

Desktop emphasizes:

```text
exploration
graph
lineage
deep recall
documents
project management
```

Mobile emphasizes:

```text
capture
quick recall
EMG
recent ideas
basic editing
sync state
```

The underlying data model remains shared.

---

# 27. Competition Demo

The ideal Arthur demo is:

```text
1. User is away from the PC.

2. Phone is connected through its private overlay network.

3. EMG gesture activates Arthur Mobile.

4. User speaks an unstructured project thought.

5. Cloud STT generates the transcript.

6. Cognitive Distillation extracts:
   - Idea
   - Task
   - Decision
   - Question

7. Everything is committed locally on the phone first.

8. If Home Node is reachable through the private network,
   the phone synchronizes immediately.

9. If Home Node is offline,
   the capture remains safely queued locally.

10. Home Node receives the capture.

11. Cognitive Graph discovers an older related idea.

12. Conflict Engine discovers a conflict with an earlier decision.

13. Thought Lineage attaches the development to the concept history.

14. User asks:
    "Arthur, how did this idea evolve?"

15. Arthur reconstructs the history and shows the source thoughts.
```

This demonstrates:

```text
AI
Voice
Local-first architecture
Cross-network device synchronization
Knowledge representation
Semantic retrieval
Graph reasoning
Temporal reasoning
Hardware HCI
```

in one coherent workflow.

---

# 28. Competition Scope Freeze

Development priority is:

```text
Tauri Foundation
        ↓
Android Cloud AI
        ↓
Local Mobile Capture
        ↓
Device Pairing
        ↓
Private Overlay Connectivity
        ↓
Reliable Home Node Sync
        ↓
Cognitive Store
        ↓
Provenance
        ↓
Distillation
        ↓
Semantic Retrieval
        ↓
Cognitive Graph
        ↓
Thought Lineage
        ↓
Cognitive Recall
        ↓
EMG Integration
        ↓
UI Polish + Benchmarks
```

Explicitly deferred:

```text
Local LLM expansion
Local mobile LLMs
Local STT/TTS expansion
Generic app control improvements
New filesystem tools
Browser automation expansion
Git agent expansion
Generic autonomous agents
Complex distributed scheduler
Arthur-owned cloud storage
Arthur-owned NAT traversal
Arthur-owned public relay infrastructure
Internet-wide custom P2P networking
Large gesture vocabulary
```

---

# 29. Relationship With Nexus and Sentry

The three systems have clearly separated technological identities.

```text
A.R.T.H.U.R.
Human cognition / knowledge / HCI

Nexus
AI orchestration / reasoning / context engineering

Sentry
Independent verification / security analysis
```

Signature technologies:

```text
Nexus
→ CCv2
→ Nexus Nova / EMv3

Sentry
→ Independent multi-harness review
→ Security Agent

Arthur
→ Cognitive Graph
→ Thought Lineage
→ Provenance-Preserving Capture
→ Cognitive Recall
→ Local-first Home Node architecture
→ EMG Intent Interface
```

Long-term integration:

```text
Human Thought
      ↓
   ARTHUR
      ↓
structured intent / knowledge
      ↓
    NEXUS
      ↓
execution / reasoning
      ↓
   SENTRY
      ↓
verification
```

---

# 30. Final Product Principle

Arthur should be useful even if the user never manually organizes a note.

The user should not be required to constantly decide:

```text
Which folder?
Which filename?
Which tags?
Which backlinks?
Where should this go?
```

Instead:

> **Capture first. Arthur organizes automatically. Inspect and edit later.**

Arthur must also remain useful independently of Home Node availability:

> **Capture now. Synchronize when possible. Never lose the thought.**

The final conceptual identity is:

> **A.R.T.H.U.R. is a local-first personal cognitive system that captures thoughts across devices, uses cloud AI to interpret them, securely synchronizes them to a user-owned Home Node over a private network, builds a structured and evolving model of the user's knowledge on hardware they own, and allows that knowledge to be recalled through semantic, relational and temporal reasoning.**