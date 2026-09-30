# pi-herdr-tab-name

[pi](https://pi.dev) extension that syncs the pi session display name (`/name`, `pi -n`, `pi.setSessionName()`) to the [herdr](https://herdr.dev) tab label — in real time, both ways that matter:

| You do | Tab label does |
|---|---|
| `/name refactor auth` | becomes `refactor auth` |
| `pi -n my-session` | becomes `my-session` on startup |
| `/resume` into a named session | follows the session's name |
| `/name` (clear) | restores the label it saw before the first rename |
| session has no name | stays untouched |

## Requirements

- [pi coding agent](https://pi.dev)
- [herdr](https://herdr.dev) with the pi agent integration installed (`herdr integration install pi`). The integration injects the `HERDR_*` environment variables this extension needs.

Outside a herdr pane (plain terminal, headless run) the extension is inert: it registers no handlers and issues no I/O.

## Install

```bash
pi install npm:pi-herdr-tab-name
```

Or from the GitHub repository:

```bash
pi install git:github.com/14sxlin/pi-herdr-tab-name
```

Try without installing:

```bash
pi -e npm:pi-herdr-tab-name
```

## How it works

pi and herdr already talk: herdr's managed `herdr-agent-state.ts` extension reports agent state and session ids over herdr's socket API, but herdr has no notion of pi's session *name*. This companion extension listens to pi's `session_start` / `session_info_changed` events and, over the same socket (`pane.get` → `tab.get` → `tab.rename`), renames the tab hosting the pane.

- One serialized queue per session; every rename path is idempotent and retried with bounded backoff (herdr's socket server intermittently ignores rapid successive connections).
- Requests time out at 2 s and every failure is swallowed — the extension can never take pi down.
- Labels are normalized: control characters collapsed, trimmed, capped at 80 chars.
- TUI only: headless pi runs inside a herdr pane never touch the shared tab label.

## Platform support

| Platform | Status |
|---|---|
| Windows + herdr 0.8.2 | tested ✅ |
| Linux / macOS | expected to work (socket endpoint logic mirrors herdr's own integration), not yet verified — issues welcome |

## Limitations

- The sync *overwrites* manual tab renames once the session is named — that is the point of the feature.
- Multiple pi panes sharing one tab: last write wins.
- herdr's `tab.rename` cannot clear a label, so "clear" restores the pre-rename label instead.

## License

MIT
