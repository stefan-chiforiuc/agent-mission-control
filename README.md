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

## Agents waiting on you

When an agent is stuck on something only you can answer, it turns **amber and pulses**:

| state | when | shown |
|-------|------|-------|
| `⏸ needs approval` | a permission dialog is open in the terminal (e.g. `Bash: npm install …`) | the tool and command, how long it has waited |
| `❓ asking` | the agent called `AskUserQuestion` | the questions and their options (detail panel) |

You still answer **in the terminal**; Mission Control only shows it, so nothing is slowed down or held back.
The header gets a **⏸ N waiting** button (click: jump to the oldest), the browser tab title shows `(N) ⏸`, and
**🔔** turns on browser notifications (click one to jump to that agent). The state clears as soon as the transcript
shows the tool ran or was denied, the agent moves on, or you type a new prompt.

This needs the `Notification` hook. Re-run `node run-me.js install <project>` for projects installed before it existed,
then restart Claude Code there.

A session stops showing as live the moment you close Claude Code (`SessionEnd` hook, installed the same way).
Without that hook it falls back to "quiet for 10 minutes".

## Progress of running work

Claude Code doesn't report how far a command has got, so the dashboard **estimates** it from your history: it reads the
newest ~80 transcripts of the project (in the background, once per dashboard start) and remembers how long each kind of call took.
`cd x && npm test -- auth` counts as `npm test`; agents count by type (`developer`, `tester`, ...). Calls you approved by hand,
failed calls and background calls are left out, so waiting for you doesn't skew the numbers.

- **Mission Control**: a busy card gets a spinner, a bar along its bottom edge, and `12s/~40s`. The detail panel shows the bar for the
  current call ("typical of 8 earlier runs") and one for the agent as a whole ("a tester usually takes ~14m").
- **Classic Radar**: a ring around the node fills up, and a label under it keeps showing the current action and its time for as long as it runs.
- The bar reaches 90% at the usual time; past that it turns striped (amber text: "usually ~40s") and never shows 100%.
- Nothing similar ran before → a sliding bar and just the elapsed time.

`/api/durations?scope=<project folder>` lists what was learned.

## Tools, skills, MCP usage

The **TOOLS · SKILLS · MCP** panel (both views) lists every built-in tool, MCP tool, skill, sub-agent type, slash command and
recorded hook run: calls, errors, average time and who called it (click a row for the full breakdown).
**THIS SESSION** is live; **ALL SESSIONS** totals this project's (or all projects') transcripts over 7 / 30 / 90 days or all time.
"Loaded but never used" lists skills, agent types, deferred tools and MCP servers the session had but never called.
Click any section title (message stream, this panel) to collapse it; the choice is remembered.
Same data as JSON: `/api/usage?scope=<project folder>|*&days=30`. Self-check: `node agent-viz/usage.test.js`.
Limits: tokens per tool aren't in the transcript, and only some hook runs are written down.

## Sessions

The session button in the header shows the session on screen (⟳ = following the latest) and how many are running.
Click it for one list of everything, grouped by state:

| group | meaning |
|-------|---------|
| ⏸ / ● **Running now** | an agent is waiting on you, or agents are working (waiting ones first) |
| ◌ **Idle** | the session is open but waiting for your next prompt |
| ⏵ **Playback** | replays you started |
| ○ **Ended** | sessions this dashboard saw that have gone quiet |
| **Past sessions on disk** | other transcripts in `~/.claude/projects` (click = open its final state) |

Every row with a transcript has **⏵ replay**. Type in the box to filter by title, first prompt or folder.

## Playback

**⏵ replay** (in the session list) re-runs a transcript step by step (pause/resume, 1x-64x, restart). Time stats follow the
session's own clock, not wall-clock. Clicking a past session opens its final state instantly - the same result a replay
reaches at its end; if that session is still running, it simply keeps updating live.
