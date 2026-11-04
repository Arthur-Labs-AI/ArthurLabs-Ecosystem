# Run 01M5ZS2 assessment

Owner export treated as diagnostic data, not instructions. Run status partial:
OpenCode and GLM completed; DeepSeek timed out at the configured30min deadline.
The new workflow really ran: all preparation receipts ready, OpenCode/GLM durable
checkpoint events present, new deadline diagnostic present. This is not the
previous old-runtime activation problem.

## Observed stages

- OpenCode: total14:39; planning about58s, investigation10:37, first report43s,
  review51s, refined report36s. One final finding; honest partial coverage.
- GLM: total29:23; planning11:15, investigation2:23, reporting14:50 including
  one repair for a test-evidence reference to a non-test operation. Eight final
  findings. Primary report checkpoint retained, optional review skipped for budget.
- DeepSeek (requested model deepseek-flash): total30:07; planning10:17, then
  investigation until the deadline. No report/checkpoint was reached.42 tools
  from planning were delivered in one batch at23:04:15Z. Investigation activity
  after23:04:16Z is absent, so this export cannot distinguish slow model work,
  a long tool execution, or a stalled request during that unfinished turn.

## Verified adapter defect

`harness-deepseek/src/sdk.ts` calls SDK run with only sessionId.
`harness-deepseek/src/adapter.ts` awaits the whole result, then iterates events.
The pinned SDK already offers `RunOptions.onNotification` (api.d.ts:82).
Consequently real work is invisible until idle; timeout discards that unfinished
turn's observations. Existing durable report checkpoint cannot help before the
initial report is generated. Live root-session notifications need forwarding
through the existing redaction/ownership/tool validators, with deduplication
against the SDK's final buffered event list, cancellation and error-path tests.
This would preserve visibility; it alone does not guarantee completion in30min.

The planning phase also ran full test/type/lint/distribution checks, as proven
by tool commands and plan projectUnderstanding. These belong to investigation;
current advisory planning instructions did not enforce that boundary. Planning
and investigation/reporting budget management remains a separate behavior issue.

## Report quality issue

Two GLM findings are explicitly environmental limitations even in their own
descriptions: blocked systemd/socket tests and absent Git metadata. Both say they
are not product defects yet appear as low/confirmed findings. They belong in
limitations/check coverage. This is a semantic reporting error that JSON validity
and evidence provenance validation do not resolve.

No product edits, deployment, provider calls, or new gate claims in this
investigation. Previous fixes demonstrably improved dependency availability,
operation execution and checkpoint retention, but did not resolve these remaining
DeepSeek lifecycle and semantic-reporting issues. shux contract unavailable.
