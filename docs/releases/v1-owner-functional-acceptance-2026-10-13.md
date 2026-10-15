# Owner-reported functional acceptance — October 13, 2026

**OWNER-REPORTED FUNCTIONAL ACCEPTANCE: Windows/WSL2 and native CachyOS.**

On October13,2026, the project owner confirmed that Sentry's normal application
functionality works on both Windows/WSL2 and native CachyOS, including independent
agent execution, agent selection, and Full/Targeted QA. The agents operate
separately as intended. No currently reproducible functional problem was reported.
The source of this record is the owner's direct Phase6.0 instruction in this
conversation; no retrospective recordings or signatures are claimed or required.

| Confirmed scope                               | Windows/WSL2                         | Native CachyOS                       |
| --------------------------------------------- | ------------------------------------ | ------------------------------------ |
| Normal application functionality              | OWNER-REPORTED FUNCTIONAL ACCEPTANCE | OWNER-REPORTED FUNCTIONAL ACCEPTANCE |
| Three independent agents / separate execution | OWNER-REPORTED FUNCTIONAL ACCEPTANCE | OWNER-REPORTED FUNCTIONAL ACCEPTANCE |
| Agent selection                               | OWNER-REPORTED FUNCTIONAL ACCEPTANCE | OWNER-REPORTED FUNCTIONAL ACCEPTANCE |
| Full and Targeted QA                          | OWNER-REPORTED FUNCTIONAL ACCEPTANCE | OWNER-REPORTED FUNCTIONAL ACCEPTANCE |

This materially satisfies the overall owner functional-confidence gate. It is
separate from automated verification, recorded physical tests and exact-build
attribution. Producing source SHA, archive checksum, backend, individual A–G
case outcomes, run counts, provider spend and full recovery execution were not
supplied. Do not infer them from the confirmation or assign an I1/RC identity.

The historical [W1/C1 records](v1-owner-acceptance-execution.md),
[Phase5.3 matrix](v1-phase-5-3-final-host-acceptance.md), original G10 FAIL,
[Windows G10-R evidence](v1-phase-5-2-g10-recovery-validation.md), automated
receipts and [owner Full3/3 export](v1-owner-run-01M4T9XG-acceptance.md) remain
unchanged. That export's10 findings/38 evidence and build-attribution limits stand.
No historical NOT RUN/ENVIRONMENT UNAVAILABLE row becomes PASS automatically.

No14-mode paid replay or retrospective screen recording is requested. Additional
paid execution would need a specific material risk, explicit provider/account/
model/run-count/budget authorization and preserved failure evidence. None was
initiated in Phase6.0. A new unsigned RC archive has its own identity; a bounded
matching-version launch check can establish that identity without running QA.

The owner separately froze feature development and authorized RC **preparation**.
This confirmation does not adopt [recovery Option A](v1-recovery-policy-decision.md),
validate native G10-R, approve an exact RC artifact, merge a PR, authorize a
release tag or publication. Those remain explicit decisions in the
[simplified RC checklist](V1_RC_READINESS_CHECKLIST.md).
