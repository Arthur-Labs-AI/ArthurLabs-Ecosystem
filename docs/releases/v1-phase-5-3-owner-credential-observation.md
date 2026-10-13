# Owner-controlled credential restart observation

**OWNER ACCEPTANCE REQUIRED; not executed by the agent.** This procedure is
read-only with respect to credential/settings operations. Normal startup and
shutdown can write Chromium/runtime bookkeeping and perform existing migration;
it is not a filesystem read-only launch. Do not run it on an uncertain profile
or executable, or approve unrelated Save/Clear/Forget/migration operations by
following this document.

1. Owner explicitly approves the existing installation/profile observation,
   confirms no active QA/retest/setup and retains a stopped backup privately
   using their normal backup process. Never send that backup to the agent.
2. Identify the exact installed executable/archive privately. Compare its
   trusted archive/manifest checksum to the [I1 lock](v1-phase-5-3-candidate-lock.md)
   and full source `c78faa74717b0f430a859730e98c3c4915e7b03f`.
   For the packaged executable its `--sentry-version` control reports identity
   without starting the runtime. Use only the already confirmed profile context.
   A source checkout's Git HEAD alone does not prove compiled executable identity.
   If it is the original beta, an unknown build or another checksum, stop and
   record identity UNVERIFIED; separately plan a compatible upgrade first.
3. Confirm the same Windows account/machine or native account/keychain, selected
   profile and shortcut arguments privately. Assign anonymous labels P-owner and
   W-owner/C-owner. No new `--user-data-dir`, copied ciphertext, changed environment
   or directory guessing. Inspect only normal presence statuses in Providers;
   do not reveal input values, use DevTools, read the store or run provider calls.
4. Record each key field's badge and available presence/source/persistence/error
   state. `Stored securely` means stored/secure; `From environment` means
   environment/environment. `Not set`, unavailable and query error are distinct.
   If the UI does not expose a field, record UNOBSERVED instead of inventing it.
   Record ordinary model-preference **presence only**. Empty password inputs are
   expected and are not the reported persistence defect.
5. With no work active, close Desktop normally and let its runtime exit. Confirm
   both stopped using normal status/owned-process observation. Do not kill an
   unrelated process, force a failed close, clear a lock or change runtime/current.
6. Reopen exactly the same verified installation, OS account, profile and normal
   launch environment. Observe connected matching runtime identity and Providers
   again. Do not click Save/Clear/Forget/Validate or edit preferences.
7. If shutdown/reopen is safe, repeat once more. Any unexpected status/profile,
   storage/query error or hung shutdown ends the track: retain sanitized states
   and failure details, preserve existing material and ask for investigation.
8. Return only the table below, verified identity and anonymous host/backend facts.
   No keys, encrypted store, DB, raw logs, personal paths or account details.

| Field / observation                                      | Before  | Restart1 | Restart2 |
| -------------------------------------------------------- | ------- | -------- | -------- |
| Exact installation source/checksum, same account/profile | NOT RUN | NOT RUN  | NOT RUN  |
| OpenRouter configured / source / persistence / error     | NOT RUN | NOT RUN  | NOT RUN  |
| OpenCode configured / source / persistence / error       | NOT RUN | NOT RUN  | NOT RUN  |
| DeepSeek configured / source / persistence / error       | NOT RUN | NOT RUN  | NOT RUN  |
| GLM configured / source / persistence / error            | NOT RUN | NOT RUN  | NOT RUN  |
| Ordinary model preferences present                       | NOT RUN | NOT RUN  | NOT RUN  |
| Matching runtime connected / graceful complete shutdown  | NOT RUN | NOT RUN  | NOT RUN  |

Approval reference/date: OWNER ACCEPTANCE REQUIRED. Result: OWNER ACCEPTANCE
REQUIRED. A pass adds owner-profile evidence to D02/D08; it does not prove billing,
native keychain behavior on another host, all D privacy cases or original G10.
