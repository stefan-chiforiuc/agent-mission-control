# Agent Mission Control

Live and replayable visualization of Claude Code agents (main agent, sub-agents, tool calls, tokens, models).

## Run

```
node run-me.js                              # start the dashboard on http://localhost:7777
node run-me.js install <project-folder>     # add the hooks to <project>/.claude/settings.local.json (merge or create)
node run-me.js uninstall <project-folder>   # remove only our hooks
```

Hooks only tell the server "a session exists / something happened". All real data (tokens, model, effort,
sub-agent tree, messages) is read from Claude Code's transcript files in `~/.claude/projects`.

## Views (look & feel)

The **View** dropdown in the header switches between the files in `agent-viz/views/`:

| id | name | |
|----|------|---|
| `mission` | Mission Control | grouped agent cards, per-agent detail, tokens, model, live activity |
| `classic` | Classic Radar | the original circular-node look |

Your choice is remembered; the selected session stays selected when you switch views.

## Which agents are shown

The **Agents** dropdown in the header applies to every view (remembered per browser):

| mode | shows |
|------|-------|
| all (history) | every agent the session ever spawned (the original behaviour) |
| active only | `main` + agents that are working right now; finished ones disappear |
| latest per type | for each agent type: the ones working now; if none of that type is working, the last one that ran (plus any that ran in parallel with it). E.g. `developer #1` finishes, `developer #2` starts → only `#2` is shown; two developers in parallel → both are shown. |

Hidden agents still count in the session totals (tokens, cost, "N hidden"). An agent whose parent is hidden is drawn under its nearest visible ancestor.

### Adding a new view

1. Copy `views/classic.html` to `views/<id>.html` (lowercase letters, digits, dashes).
2. Set its `<title>` (shown in the dropdown) and optionally `<meta name="mc-description" ...>` / `<meta name="mc-order" content="3">`.
3. Keep `<link rel="stylesheet" href="/core.css">`, `<header id="mc-header"></header>` and `<script src="/core.js"></script>`.
4. Draw with `MC.start({ id, onSnap, onEvent, onSession, onReset, onTheme, onTick })` - see the comment at the top of `core.js`
   for the data shape and the helpers (`MC.nameMap`, `MC.colorOf`, `MC.nowOf`, `MC.buildTree`, `MC.effStatus`, ...).

No server restart is needed; reload the page and the new view appears in the dropdown.

## Seeing everything

- **ALL AGENTS** tab (Mission Control, bottom-left) lists every agent of the session, finished ones included, with model, start time,
  duration, tokens, tool count, task and last message. Click a row to open it in the detail panel.
- **Message stream** has kind toggles (prompts / tasks / results / says / tools) and a limit (last 400 / 2000 / show all); the header shows "shown of total".
- **Timeline** window defaults to the whole session (up to 30 min); agents that ended outside the window stay as a "ended N ago" lane.
- History is kept per session (20,000 events), and on start the server re-reads sessions that were active in the last 30 minutes.
- "Follow latest session" stays on the session you are watching until it has been quiet for 90 seconds; pick a session explicitly to pin it.

## Playback

**Replay past session...** re-runs a finished transcript step by step (pause/resume, 1x-64x, restart). Time stats follow the
session's own clock, not wall-clock. **Open final state...** shows a past session's end result instantly.
