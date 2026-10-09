# Marginalia Mobile: locked decisions

Approved after the M03.1B exploration. These are design decisions, not implementation. `apps/arthur` is unchanged.

## Product

1. **Home variant C, the Speak page, is the canonical mobile Home.** Variants A and B stay in the playground as the record of what was compared, not as options.
2. **Connections defaults to List.** Map is an explicit secondary mode (toggle).
3. **Evolution is the vertical temporal rail**, with in-place expansion of the selected revision.
4. **Idea detail is a full-screen mobile page.** The exploration found no reason strong enough to use a sheet.

## Capture and microphone

5. **The centre Capture action starts recording immediately when microphone permission is already granted.**
6. **If permission is not granted, Capture opens the capture surface (Home) and does nothing else.** The permission request happens only after an explicit user action: tapping **Speak**. Navigation alone never raises a permission dialog. The surface shows one quiet line: "Tap Speak and Android will ask to use the microphone. Nothing is recorded until then."
7. **Raw microphone audio is temporary and is never durable Arthur knowledge.** There is no recording library, no playback, no audio history.
8. **A retryable STT / network failure may keep the app-private temporary audio, only for the active retry flow**, so the user can retry transcription without speaking again. UI: "Retry transcription" and "Discard recording".
9. **Temporary audio is deleted on:** transcription success · discard · leaving the retry flow · terminal failure · TTL expiry · startup cleanup.
10. **Safety TTL for retry audio: 10–15 minutes** (the design copy says 15).
11. **Non-retryable failures keep nothing** (speech-to-text not configured or rejected credentials, empty transcript, interruption, recording failure). The copy says "Nothing was saved."

The user-facing rule of thumb the copy teaches: *a recording is kept on this phone only while you retry; it is deleted once it is transcribed, if you discard it, when you leave this screen, or after 15 minutes.*

## What changed in the playground

- The Capture tab is `capTab`: records if permission is granted, otherwise opens Home with the hint (preset `home-nopermission`). Speak is the only thing that asks (`home-permission`).
- New outcomes: *First use: microphone not allowed yet*, *Transcription fails: retryable*, *Speech service unavailable: not retryable*.
- New screens: `home-nopermission`, `home-sttfail` (retry variant), `home-sttterminal`.
- Leaving Home (any tab, idea, Settings) while the retry card is showing deletes the audio, as in the decision list.
