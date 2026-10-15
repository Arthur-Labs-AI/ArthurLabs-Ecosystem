# Native CachyOS Phase5.3 partial acceptance receipt

**Template only; no native results executed by the preparing agent.** Copy per
actual operator attempt; retain failures and link retests. Use the
[operator workflow](v1-phase-5-3-cachyos-operator.md),
[candidate lock](v1-phase-5-3-candidate-lock.md) and [case definitions](v1-owner-acceptance.md).
No partial receipt approves the whole campaign or Phase6.

| Host field                                                                                | Actual value                                                                                                   |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Anonymous host/operator/date/approval reference                                           | NOT RUN                                                                                                        |
| Native OS ID/version/kernel/architecture                                                  | NOT RUN                                                                                                        |
| Desktop environment / X11 or Wayland / actual visible GUI                                 | NOT RUN                                                                                                        |
| Same non-root disposable account / isolated HOME/profile/runtime confirmed                | NOT RUN                                                                                                        |
| Actual secure-storage backend and evidence source / availability                          | NOT RUN                                                                                                        |
| Node / pnpm / systemd / bubblewrap / socat versions                                       | NOT RUN                                                                                                        |
| Source / tree                                                                             | c78faa74717b0f430a859730e98c3c4915e7b03f / 8bbaab4a5d1f7830dcf4ed7b4c40362c62f8d71d (expected; actual NOT RUN) |
| Exact archive                                                                             | sentry-0.1.0-beta.1-c78faa74717b-cachyos-x64.tar.gz                                                            |
| Trusted archive SHA256 / actual SHA256                                                    | 5bd3642ed392607a010078be35885d1cff45db162a2841ee374be228275e89d8 / NOT RUN                                     |
| Manifest hash / Desktop identity / runtime hello / protocol1                              | NOT RUN                                                                                                        |
| Install/launch / staging/current / repeat setup                                           | NOT RUN                                                                                                        |
| Actual sandbox capability / eight separate case outcomes                                  | NOT RUN                                                                                                        |
| Four configured/source/persistence restart observations (initial/restart1/restart2)       | NOT RUN                                                                                                        |
| Ordinary preferences present across restart                                               | NOT RUN                                                                                                        |
| Canonical schema/payload/material/export comparison, baseline vs upgrade/restore/restarts | NOT RUN                                                                                                        |
| Stopped matching backup / staged verification / maintenance/refusal/recovery              | NOT RUN                                                                                                        |
| Original G10 vs G10-R distinction / policy approval                                       | OWNER ACCEPTANCE REQUIRED                                                                                      |
| Private receipt retained / shared sanitized evidence references                           | NOT RUN                                                                                                        |

Use PASS/FAIL/NOT RUN/ENVIRONMENT UNAVAILABLE/OWNER ACCEPTANCE REQUIRED, or BLOCKED
with a named failed prerequisite. Replace one row only when it actually ran;
record command/action, exit, observation, source/checksum, failure/retest reference.
Counts/hash equality alone does not prove keychain decryption. No keys, ciphertext,
raw databases, private paths, provider text or machine logs in this return.

| Case         | Initial status            | Command/action + exit + observed result | Sanitized evidence / failure / retest |
| ------------ | ------------------------- | --------------------------------------- | ------------------------------------- |
| A01          | ENVIRONMENT UNAVAILABLE   | NOT RUN                                 | NOT RUN                               |
| A02          | ENVIRONMENT UNAVAILABLE   | NOT RUN                                 | NOT RUN                               |
| A03          | ENVIRONMENT UNAVAILABLE   | NOT RUN                                 | NOT RUN                               |
| A04          | ENVIRONMENT UNAVAILABLE   | NOT RUN                                 | NOT RUN                               |
| A05          | ENVIRONMENT UNAVAILABLE   | NOT RUN                                 | NOT RUN                               |
| A06          | ENVIRONMENT UNAVAILABLE   | NOT RUN                                 | NOT RUN                               |
| A07          | ENVIRONMENT UNAVAILABLE   | NOT RUN                                 | NOT RUN                               |
| A08          | ENVIRONMENT UNAVAILABLE   | NOT RUN                                 | NOT RUN                               |
| C01          | ENVIRONMENT UNAVAILABLE   | NOT RUN                                 | NOT RUN                               |
| C02          | ENVIRONMENT UNAVAILABLE   | NOT RUN                                 | NOT RUN                               |
| C03          | ENVIRONMENT UNAVAILABLE   | NOT RUN                                 | NOT RUN                               |
| C04          | ENVIRONMENT UNAVAILABLE   | NOT RUN                                 | NOT RUN                               |
| C05          | ENVIRONMENT UNAVAILABLE   | NOT RUN                                 | NOT RUN                               |
| C06          | ENVIRONMENT UNAVAILABLE   | NOT RUN                                 | NOT RUN                               |
| C07          | ENVIRONMENT UNAVAILABLE   | NOT RUN                                 | NOT RUN                               |
| C08          | ENVIRONMENT UNAVAILABLE   | NOT RUN                                 | NOT RUN                               |
| C09          | ENVIRONMENT UNAVAILABLE   | NOT RUN                                 | NOT RUN                               |
| C10          | ENVIRONMENT UNAVAILABLE   | NOT RUN                                 | NOT RUN                               |
| C11          | ENVIRONMENT UNAVAILABLE   | NOT RUN                                 | NOT RUN                               |
| D01          | ENVIRONMENT UNAVAILABLE   | NOT RUN                                 | NOT RUN                               |
| D02          | ENVIRONMENT UNAVAILABLE   | NOT RUN                                 | NOT RUN                               |
| D03          | ENVIRONMENT UNAVAILABLE   | NOT RUN                                 | NOT RUN                               |
| D04          | ENVIRONMENT UNAVAILABLE   | NOT RUN                                 | NOT RUN                               |
| D05          | ENVIRONMENT UNAVAILABLE   | NOT RUN                                 | NOT RUN                               |
| D06          | ENVIRONMENT UNAVAILABLE   | NOT RUN                                 | NOT RUN                               |
| D07          | ENVIRONMENT UNAVAILABLE   | NOT RUN                                 | NOT RUN                               |
| D08          | ENVIRONMENT UNAVAILABLE   | NOT RUN                                 | NOT RUN                               |
| E01-Full     | OWNER ACCEPTANCE REQUIRED | NOT RUN                                 | NOT RUN                               |
| E01-Targeted | OWNER ACCEPTANCE REQUIRED | NOT RUN                                 | NOT RUN                               |
| E02-Full     | OWNER ACCEPTANCE REQUIRED | NOT RUN                                 | NOT RUN                               |
| E02-Targeted | OWNER ACCEPTANCE REQUIRED | NOT RUN                                 | NOT RUN                               |
| E03-Full     | OWNER ACCEPTANCE REQUIRED | NOT RUN                                 | NOT RUN                               |
| E03-Targeted | OWNER ACCEPTANCE REQUIRED | NOT RUN                                 | NOT RUN                               |
| E04-Full     | OWNER ACCEPTANCE REQUIRED | NOT RUN                                 | NOT RUN                               |
| E04-Targeted | OWNER ACCEPTANCE REQUIRED | NOT RUN                                 | NOT RUN                               |
| E05-Full     | OWNER ACCEPTANCE REQUIRED | NOT RUN                                 | NOT RUN                               |
| E05-Targeted | OWNER ACCEPTANCE REQUIRED | NOT RUN                                 | NOT RUN                               |
| E06-Full     | OWNER ACCEPTANCE REQUIRED | NOT RUN                                 | NOT RUN                               |
| E06-Targeted | OWNER ACCEPTANCE REQUIRED | NOT RUN                                 | NOT RUN                               |
| E07-Full     | OWNER ACCEPTANCE REQUIRED | NOT RUN                                 | NOT RUN                               |
| E07-Targeted | OWNER ACCEPTANCE REQUIRED | NOT RUN                                 | NOT RUN                               |
| F01          | ENVIRONMENT UNAVAILABLE   | NOT RUN                                 | NOT RUN                               |
| F02          | ENVIRONMENT UNAVAILABLE   | NOT RUN                                 | NOT RUN                               |
| F03          | ENVIRONMENT UNAVAILABLE   | NOT RUN                                 | NOT RUN                               |
| F04          | ENVIRONMENT UNAVAILABLE   | NOT RUN                                 | NOT RUN                               |
| F05          | ENVIRONMENT UNAVAILABLE   | NOT RUN                                 | NOT RUN                               |
| F06          | ENVIRONMENT UNAVAILABLE   | NOT RUN                                 | NOT RUN                               |
| F07          | ENVIRONMENT UNAVAILABLE   | NOT RUN                                 | NOT RUN                               |
| G01          | ENVIRONMENT UNAVAILABLE   | NOT RUN                                 | NOT RUN                               |
| G02          | ENVIRONMENT UNAVAILABLE   | NOT RUN                                 | NOT RUN                               |
| G03          | ENVIRONMENT UNAVAILABLE   | NOT RUN                                 | NOT RUN                               |
| G04          | ENVIRONMENT UNAVAILABLE   | NOT RUN                                 | NOT RUN                               |
| G05          | ENVIRONMENT UNAVAILABLE   | NOT RUN                                 | NOT RUN                               |
| G06          | ENVIRONMENT UNAVAILABLE   | NOT RUN                                 | NOT RUN                               |
| G07          | ENVIRONMENT UNAVAILABLE   | NOT RUN                                 | NOT RUN                               |
| G08          | ENVIRONMENT UNAVAILABLE   | NOT RUN                                 | NOT RUN                               |
| G09          | ENVIRONMENT UNAVAILABLE   | NOT RUN                                 | NOT RUN                               |
| G10          | ENVIRONMENT UNAVAILABLE   | NOT RUN                                 | NOT RUN                               |
| G10-R        | ENVIRONMENT UNAVAILABLE   | NOT RUN                                 | NOT RUN                               |

Owner acceptance/signature/date: OWNER ACCEPTANCE REQUIRED. Final Phase6 authorization: NOT AUTHORIZED.
