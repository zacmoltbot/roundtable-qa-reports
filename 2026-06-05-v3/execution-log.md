# RoundTable User-Facing QA v3 Execution Log

- Target: `https://doppel-health.zeabur.app/group`
- Started: `2026-06-05T16:58:00Z`
- Model policy: inherited default model
- Scope: end-user `/group` flow only
- Status: IN PROGRESS

## Phase 1 - Context and Criteria

- Read required workspace context, Reviews 1-8, functional criteria, performance criteria, and v2 artifacts.
- Confirmed required result taxonomy and separation of Product Result from QA Execution Status.
- Confirmed F-13/F-14 must be attempted end-to-end with the Mandarin WAV fixture and are not dependent on browser output capture.
- Confirmed actual audible output is required for product verdicts on F-06/F-07/F-09.
- Confirmed performance main matrix must use user-observable endpoints; engineering events belong only in the appendix.

## Checkpoints

- `2026-06-05T17:03:00Z`: v3 report directory initialized before browser execution.
- `2026-06-05T17:17:00Z`: OpenClaw browser preflight PASS (`profile=openclaw`, local Chromium/CDP healthy).
- `2026-06-05T17:31:00Z`: Fresh-profile Playwright evidence run started with Mandarin WAV fake microphone, screenshot capture, user-visible timings, and audio-response interception.
- `2026-06-05T17:15:00Z`: Homepage mic recording state verified; no transcript or expert-selection route appeared within 90 seconds after the Mandarin fixture attempt.
- `2026-06-05T17:16:00Z`: Custom-topic recommendations, scores/reasons, selected-expert carryover, early summary, and real TTS response assets captured.
- `2026-06-05T17:18:00Z`: Local fixture verified as 9.9-second, mono 48 kHz PCM and non-silent; local Whisper transcription materially matches the intended sleep request.
- `2026-06-05T17:19:00Z`: Captured TTS MP3 verified as non-silent (`mean_volume -22.3 dB`, `max_volume -6.2 dB`) and locally transcribed as the visible speaker introducing himself as 白大衛. Actual device/speaker playback remains unverified.
- `2026-06-05T17:32:00Z`: F-13 rerun completed: homepage Mandarin STT returned a materially correct 200 transcript and successfully submitted to expert selection.
- `2026-06-05T17:33:00Z`: F-14 completed: two separate chat mic recording/stop interactions returned materially correct 200 STT transcripts and relevant expert responses.
- `2026-06-05T17:34:00Z`: Full matrix completed. Confirmed product failure: F-15 full summary showed only the topic with no meaningful summary after multiple expert, text, and voice interactions.
- `2026-06-05T17:40:00Z`: Truthful local `raw-results.json` and mobile-readable `index.html` generated with Product Result separated from QA Execution Status.

## Environment Findings

- Required browser path available: local Chromium via OpenClaw and Playwright.
- Mandarin WAV fixture exists and is injected through Chromium fake microphone flags.
- No `pactl`, `parec`, or `/dev/snd` was found. This constrains verification of real speaker/device playback, but does not block STT or returned-audio-asset analysis.
- `GITHUB_TOKEN` exists in the environment; GitHub Pages deployment will be attempted only after the truthful local report is complete.
- Drive OAuth credentials and upload script exist; Drive backup will be attempted after local report verification.

## Final Functional Outcome

- Product PASS: 12
- Product FAIL: 1 (`F-15`)
- Product undetermined because complete audible-device verification was blocked: 3 (`F-06`, `F-07`, `F-09`)
- QA execution completed for all other items.

## Taxonomy Notes

- F-06/F-07/F-09 are not labeled product `PARTIAL` or `FAIL`. Returned non-silent TTS assets and visible UI progression are supporting evidence, but actual device playback was not captured.
- F-13/F-14 are `PASS` because the Mandarin WAV was tested end to end and produced materially correct STT plus the required downstream flow/response.
- F-15 is `FAIL`, not a test gap: sufficient history was deliberately built and the summary still contained only the topic.
