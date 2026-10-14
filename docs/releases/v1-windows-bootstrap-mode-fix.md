# Windows packaged setup: explicit WSL bootstrap mode

Status: **WINDOWS RELEASE BLOCKER — correction prepared for owner review**.
This focused fix branches from approved dev
`62b474e53ae56a2fc12365c0140b2fa69fad3a51` and targets dev independently of
the Windows scope-transition [PR #23](https://github.com/Mert1026/Sentry/pull/23).
That PR was returned to draft when the owner reproduced this failure.

## Reproduction and cause

The owner verified and extracted the hosted `16b47d83da58` Windows ZIP, then ran
its PowerShell `setup -Distro Ubuntu`. Ubuntu selection succeeded, but the Linux
bootstrap printed the native CachyOS-only refusal. Setup failed before staging
or activating the new runtime, retaining the previous current runtime. Starting
the new Desktop then correctly refused the mismatched release identity.
The SQLite experimental warning is not the cause. Do not weaken identity checks.

`Invoke-DistributionLinux` declared a parameter named `$Args`, which collides
with PowerShell's automatic `$args` variable. Binding `-Args @('wsl')` did not
retain that value in the function body. The process received `bash <script>`;
`bootstrap-runtime.sh` defaulted to native mode instead of receiving `wsl`.

The correction renames only the parameter and its setup/repair call site to
`ScriptArguments`. Native CachyOS enforcement, WSL checks, sandbox prerequisites,
frozen dependencies, runtime activation/rollback and full identity checks remain
unchanged. No provider/model/SDK, version, schema or credential behavior changes.

## Regression evidence

New `windows-launcher.test.mjs` executes the actual packaged PowerShell entrypoint
under Windows PowerShell 5, with only OS/process/configuration boundaries replaced
by disposable fixtures. It never touches the owner's WSL deployment, profile,
data or credentials. It covers setup and repair forwarding `wsl`, paths containing
spaces, stop-before-maintenance ordering, zero-argument maintenance, existing
tool pins, and refusal to activate preferences after translation/bootstrap failure.

- RED: setup and repair failed with the native-mode refusal; three other cases
  passed. The failure matched the reported defect, not a fixture setup error.
- GREEN: all five cases passed after the three-line correction.
- Windows distribution suite after its prerequisite build: 31 passed / 27
  platform/capability skips. An initial run began before build output existed and
  failed importing persistence dist; that attempt is retained separately.
- Frozen install, repository hygiene, format, lint, typecheck, build, PowerShell
  syntax and maintenance fixtures passed. Turbo reported cached static/build
  tasks; real packaging recompiles committed input independently.

Exact fix-head CI, review artifact and real PowerShell-to-WSL bootstrap results
are recorded in the fix PR and private verification receipt. Do not infer a
successful owner installation or official RC acceptance from fixture results.

## Existing archive test workaround

The owner's immutable archive must not be edited or have its manifest rewritten.
After graceful Desktop shutdown, invoking that archive's verified
`scripts/distribution/bootstrap-runtime.sh` through WSL with the explicit final
argument `wsl` exercises the unchanged correct Linux path. This installs the
runtime for that same archive/source; it does not disable identity or sandbox
checks. Verify the resulting runtime identity before reopening that Desktop.
Use the same Windows account/WSL user; no credential re-entry or data deletion is
part of this correction. The old runtime was retained because setup failed.

## Remaining release integration

The normal packaged setup path in the earlier scope-transition artifacts is
broken. Earlier GUI import/integrity receipts remain valid for their explicit
isolated runtime path, but did not validate this PowerShell setup handoff.
Integrate the reviewed correction, refresh the Windows scope PR from the
approved integration, rerun applicable CI, and build a fresh exact-source archive
before Windows release authorization. No self-merge, tag, publication or main
promotion is authorized by this fix.
