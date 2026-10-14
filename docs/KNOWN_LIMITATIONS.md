# Known Limitations

## Platform (Apple / Mirroir)

- **Live view needs its own Screen Recording grant.** The viewer streams the iPhone
  Mirroring window with ScreenCaptureKit (the bundled `iphone-ai-capture` helper, up to
  30 fps). Without the grant, or if the helper fails, it falls back to polling Mirroir's
  `screenshot` tool (≈2 fps, PNG over MCP). The viewer shows which source is live and the
  measured FPS/latency.
- **Every input action costs ~0.6 s of window activation.** Mirroir brings iPhone
  Mirroring to the front and waits for macOS to settle before each tap or gesture. This
  is inside Mirroir and is not changed by iPhone AI.
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

## Live view (ScreenCaptureKit)

The `iphone-ai-capture` helper captures only the Mirroring window, never posts input and
never presses Resume. Frames are used for display only: the AI and touch mapping still use
Mirroir's own screenshots and window geometry, so a stale or mismatched live frame cannot
misplace a tap. Polling pauses only while live frames actually arrive (one within the last
2 s) and resumes on its own when they stop.

## Not yet verified on a real device

See [TESTING.md](TESTING.md) for exactly which behaviours were verified against the real
iPhone and which only against the mock Mirroir server.
