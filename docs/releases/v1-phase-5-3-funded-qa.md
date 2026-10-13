# Owner-controlled Full / Targeted acceptance plan

**No paid execution authorized or initiated.** Each host has14 independent
combinations. Native and Windows evidence are separate. Use the
[I1 candidate lock](v1-phase-5-3-candidate-lock.md); provider models/SDKs/pins and
independent orchestration remain unchanged. No active Merger/Verifier stage.

The owner's prior Windows/WSL E07-Full export completed3/3,10 findings/38 evidence.
Its [receipt](v1-owner-run-01M4T9XG-acceptance.md) preserves the actual result and
609 validated schema records, warnings and attribution limits. Producing Sentry
source/archive, actual snapshot bytes, log export and reopen observations remain
unverified. Do not convert it to an I1 pass or initiate a replacement automatically.

## Approval, attribution and spending

Before any Start, owner records anonymous host/account labels, permitted providers,
actual existing model configuration, disposable project/revision, maximum run
count and hard account spend/token ceilings. Verify funded accounts in their
normal dashboards; configured keys alone do not prove usable billing. No real
keys in receipts. Stop at the first failure, cancellation, unknown billing or
ceiling; retain the attempt. No automatic retries or paid replays for acceptance.
Application cancellation cannot guarantee a provider will cease billing instantly;
use provider account limits and conservative run allowances. This plan grants no
budget, retry or live-validation permission.

Before each case record source/full tree and archive/manifest SHA256, installed
Desktop identity and runtime hello matching I1/version0.1.0-beta.1/protocol1.
Record UI-selected agents and observed AgentRun model/adapter/SDK identities after
execution; compare with existing approved configuration, do not change pins.
Record producing run ID together with this receipt: exports currently omit Sentry
build SHA, so export model identities cannot substitute for application identity.

Use one small disposable project with a known deterministic defect and bounded
local test command. Import/freeze its revision, record hash and snapshot; keep
private material locally. For Targeted, record explicit relevant path(s) and
scope before Start. Do not change source mid-campaign. Run sequentially, one
click per approved attempt, confirm no other operation active.

| ID / agents             | Full I1 Windows                                                | Targeted I1 Windows       | Native modes              | Specific criteria                                                             |
| ----------------------- | -------------------------------------------------------------- | ------------------------- | ------------------------- | ----------------------------------------------------------------------------- |
| E01 OpenCode            | OWNER ACCEPTANCE REQUIRED                                      | OWNER ACCEPTANCE REQUIRED | OWNER ACCEPTANCE REQUIRED | Exactly one OpenCode AgentRun; no DeepSeek/GLM execution                      |
| E02 DeepSeek            | OWNER ACCEPTANCE REQUIRED                                      | OWNER ACCEPTANCE REQUIRED | OWNER ACCEPTANCE REQUIRED | Exactly one DeepSeek AgentRun; no OpenCode/GLM execution                      |
| E03 GLM                 | OWNER ACCEPTANCE REQUIRED                                      | OWNER ACCEPTANCE REQUIRED | OWNER ACCEPTANCE REQUIRED | Exactly one GLM AgentRun; no OpenCode/DeepSeek execution                      |
| E04 OpenCode + DeepSeek | OWNER ACCEPTANCE REQUIRED                                      | OWNER ACCEPTANCE REQUIRED | OWNER ACCEPTANCE REQUIRED | Exactly those two independent AgentRuns; no GLM                               |
| E05 OpenCode + GLM      | OWNER ACCEPTANCE REQUIRED                                      | OWNER ACCEPTANCE REQUIRED | OWNER ACCEPTANCE REQUIRED | Exactly those two independent AgentRuns; no DeepSeek                          |
| E06 DeepSeek + GLM      | OWNER ACCEPTANCE REQUIRED                                      | OWNER ACCEPTANCE REQUIRED | OWNER ACCEPTANCE REQUIRED | Exactly those two independent AgentRuns; no OpenCode                          |
| E07 all three           | OWNER ACCEPTANCE REQUIRED; prior unattributed success retained | OWNER ACCEPTANCE REQUIRED | OWNER ACCEPTANCE REQUIRED | Exactly three independent AgentRuns; no extra orchestration or duplicate work |

Recommended order if approved: E01–E03 Full then Targeted; review cost/outcomes,
then E04–E06 Full then Targeted; review again, then E07 modes. This is14 maximum
successful planned attempts per host, **not** permission for14 or for replacements.
Owner may authorize a smaller batch and submit partial evidence. Leave all
unexecuted modes owner-required. Reuse prior E07 only if missing attribution and
observations can actually be established; otherwise owner decides whether to
fund a new exact-I1 attempt.

For each mode: select agents in Desktop, inspect readiness, record scope, click
Start once; observe truthful independent progress and terminal status. Completed
does not require a nonzero finding count. Inspect canonical run, selected
AgentRuns, revision/context/snapshot, findings/evidence ownership and useful
partial results. Export **both JSON and log** through normal Save As to private
files, hash them, gracefully close/reopen and compare persisted history and
exports. No unselected agent, fabricated completed state or duplicate paid work.
Record warnings/failures without raw provider responses. Retain all failed,
interrupted and cancelled attempts. Record usage/token/cost only where already
reported by the application/provider account; otherwise UNOBSERVED, not zero.

F01/F02 cancellation, F05 interruption, F06 maintenance refusal and F07 active
retest are separately budgeted scenarios. A successful E run does not pass them.
Before any controlled interruption, approve the exact owned process/operation
and preserve current IDs/evidence. Cancel normally, wait for selected agents to
settle, confirm retained truthful terminal state/no owned orphans/no duplicate
attempts, then reopen/export. Never kill unrelated processes or retry silently.

## Offline audit of a supplied JSON export

The following existing-schema audit performs no network/provider requests and
prints only counts/boolean integrity. Run in a clean built I1 checkout using a
private export path. Supply expected mode (`full` or `targeted`) and exact
comma-separated AgentStack IDs recorded before Start; do not derive expected
selection from the exported results. Schema values/errors/raw content stay private.
This checks schema, selection and relationships; it does **not** attest build
SHA, actual snapshot bytes, DB persistence, log contents, billing, all event
semantics or cancellation. Those require the receipt observations above.

```bash
node --input-type=module - "$EXPORT" "$MODE" "$EXPECTED_AGENTS" <<'JS'
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import * as s from './packages/schemas/dist/index.js';
try {
  const [file,mode,selection]=process.argv.slice(2);
  if (!['full','targeted'].includes(mode) || !selection) throw Error();
  const bytes=readFileSync(file), d=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));
  const expected=selection.split(',').sort();
  const requireTrue=value=>{if(!value)throw Error();};
  requireTrue(expected.length>=1 && expected.length<=3 && new Set(expected).size===expected.length);
  const definitions={qaRun:'QARunSchema',projectRevision:'ProjectRevisionSchema',
    projectSnapshot:'ProjectSnapshotSchema',projectContextSnapshot:'ProjectContextSnapshotSchema',
    agentRuns:'AgentRunSchema',investigationPlans:'AgentInvestigationPlanSchema',
    emergentHypotheses:'EmergentHypothesisSchema',runActivities:'RunActivitySchema',
    findings:'FindingSchema',evidence:'EvidenceSchema',artifacts:'ArtifactSchema'};
  let records=0;
  for(const [key,name] of Object.entries(definitions))
    for(const value of Array.isArray(d[key])?d[key]:[d[key]]) {
      requireTrue(s[name].safeParse(value).success); records++;
    }
  for(const row of d.harnessEvents) {requireTrue(s.HarnessEventSchema.safeParse(row.event).success);records++;}
  const q=d.qaRun, agents=new Map(d.agentRuns.map(a=>[a.id,a]));
  requireTrue(q.executionKind==='production' && q.mode===mode);
  requireTrue(JSON.stringify([...q.configuration.agentStackIds].sort())===JSON.stringify(expected));
  requireTrue(JSON.stringify(d.agentRuns.map(a=>a.agentStackId).sort())===JSON.stringify(expected));
  requireTrue(agents.size===expected.length && d.agentRuns.every(a=>a.qaRunId===q.id));
  requireTrue(q.snapshotId===d.projectSnapshot.id && q.projectContextSnapshotId===d.projectContextSnapshot.id);
  requireTrue(d.projectSnapshot.projectRevisionId===d.projectRevision.id);
  requireTrue(d.projectSnapshot.contentHash===d.projectRevision.contentHash);
  requireTrue([d.projectRevision,d.projectSnapshot,d.projectContextSnapshot].every(x=>x.projectId===q.projectId));
  const evidence=new Map(d.evidence.map(e=>[e.id,e]));
  requireTrue(evidence.size===d.evidence.length && new Set(d.findings.map(f=>f.id)).size===d.findings.length);
  requireTrue(d.evidence.every(e=>e.qaRunId===q.id && agents.has(e.agentRunId)));
  requireTrue(d.findings.every(f=>f.qaRunId===q.id && agents.get(f.agentRunId)?.agentStackId===f.sourceAgentStackId
    && f.evidenceIds.every(id=>evidence.get(id)?.agentRunId===f.agentRunId)));
  requireTrue(d.harnessEvents.every(r=>agents.has(r.event.agentRunId)));
  console.log(JSON.stringify({offlineIntegrity:true,sha256:createHash('sha256').update(bytes).digest('hex'),
    records,agents:agents.size,findings:d.findings.length,evidence:d.evidence.length}));
} catch {console.error('Offline audit refused; keep the original export private and investigate.');process.exitCode=1;}
JS
```

Acceptance of each case requires its full terminal/outcome/history/export/usage
receipt even if this audit passes. The audit deliberately permits a truthful
failed/cancelled run for inspection; it does not declare that attempt successful.
