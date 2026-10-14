# Known Limitations

## Platform (Apple / Mirroir)

- **Not video.** The live viewer polls Mirroir's `screenshot` tool (≈2 fps active by
  default). Each frame is a full PNG capture; FPS and latency are shown as measured.
  A ScreenCaptureKit stream of the Mirroring window could be smoother, but it needs
  its own Screen Recording grant and capture code; it was investigated but **not
  implemented**, because it could not be proven reliable on this machine without that
  grant (see "ScreenCaptureKit" below).
- **Focus stealing.** Every input action makes iPhone Mirroring the frontmost app
  (macOS delivers synthetic input only to the frontmost app). iPhone AI can re-focus
  itself after manual actions, but focus still moves briefly. Avoid typing elsewhere on
  the Mac while the AI is acting.
- **Same Space.** iPhone AI and iPhone Mirroring must be in the same macOS Space.
- **One pointer.** iPhone Mirroring exposes a single touch; true multi-touch is not possible.
  `pinch`/`rotate`/`hold_keys` are not exposed by iPhone AI.
- **No on-screen keyboard**; typing uses the Mac keyboard path. Characters without a key
  mapping (Arabic, emoji, CJK) are pasted through Universal Clipboard and may not arrive.
- **`open_url` is unsupported** for the iPhone target (Mirroir refuses it). The AI opens
  Safari and types the address instead.
- **`press_back` always reports success** in Mirroir; iPhone AI verifies by re-observing.
- **Paused / locked phone.** When iPhone Mirroring is paused, screenshots and input
  would make Mirroir click "Resume"; iPhone AI waits for you instead (a Resume button is
  provided).
- **OCR-based perception.** Screen understanding uses Mirroir's on-device OCR plus
  screenshots for vision models. Icon-only buttons have no labels, so policy rules based
  on labels cannot recognise them; Assisted mode (approve every action) is the strongest
  guarantee for sensitive apps.
- **Mirroir serial processing.** Mirroir handles one request at a time and cannot cancel a
  running tool; STOP therefore terminates and restarts Mirroir when an input action is
  executing.

## Safety-policy trade-offs

- In Supervised mode, pressing Return or tapping an unlabeled/"Send"-like control after
  typing requires approval — even for harmless searches — because the same gesture sends
  messages and submits forms.
- Keyword rules are English/Arabic substring/word matches on OCR text; they can produce
  false positives (extra approvals) and false negatives (unlabeled icons).
- Blocked-app detection covers launches, taps on labels containing the app name, and
  typing the app name. An app reached another way (e.g. a notification) is detected only
  by its on-screen text.

## AI providers

- **Claude Code login** is for personal use only (Anthropic's terms). It needs the bundled
  Claude Code engine (~240 MB) and an existing Claude Code sign-in; the connection test
  checks that credentials exist, not that they are valid.
- Small local models often cannot drive multi-step tasks reliably or lack tool calling.
- Cloud providers receive screenshots/on-screen text during tasks (disclosed in the app).

## ScreenCaptureKit investigation

Mirroir already captures with `SCScreenshotManager` per screenshot. A continuous
`SCStream` on the iPhone Mirroring window (via a small Swift helper streaming JPEG frames)
would allow ~15–30 fps preview. Requirements: Screen Recording permission for iPhone AI,
the window being shareable, and a helper binary signed with the app. Because Screen
Recording was not granted in the build environment, reliability could not be measured, so
the feature was not shipped. Polling remains the honest, verified path.

## Not yet verified on a real device

See [TESTING.md](TESTING.md) for exactly which behaviours were verified against the real
iPhone and which only against the mock Mirroir server.
