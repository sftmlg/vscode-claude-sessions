# Claude Sessions for VS Code

Keeps Claude Code sessions that run in VS Code terminal tabs restorable. Tab names, order and splits are saved per repository, so after a crash or restart one click brings the named tabs back with `claude --resume`.

## Keywords

vscode, vs code, extension, claude code, terminal tabs, restore tabs, restore sessions, lost sessions, claude resume, tab names, split terminals, session names

## The view

Activity bar → **Claude Sessions** shows one list with two folders:

- **Open** — Claude sessions running in terminal tabs of this window, in tab order, with splits shown as `Split: A | B`. Clicking an entry focuses its tab.
- **Closed** — every Claude session of this repository that is not running, newest last message first (default: last 14 days). Sessions you named are marked with a bookmark icon.

Each entry shows `last <date time> · started <date time>`; hovering shows your last message and the last reply.

Buttons on an entry:

| Button | Action |
|---|---|
| ▶ | Resume in the active terminal: an idle shell runs `claude --resume <id>`, a running Claude switches via `/resume <id>`, a busy terminal gets a new tab instead |
| ＋ | Resume in a new tab |
| ✎ | Rename |
| ✕ | Remove from saved tabs |

Title bar: **Restore saved tabs** reopens every saved tab that is not running, with its name and split layout.

## Names

- A name you give a terminal tab is saved and also becomes the Claude session name (`/rename <name>`, sent while the session is idle).
- Right-click a tab → **Rename tab (and session)** does both immediately.
- VS Code reports Claude's own title (`✳ …`) through the API rather than a custom tab name; a custom name is recognised as soon as it does not look like a Claude or shell title.

## What is saved

- One file per repository: `.vscode/claude-sessions.json`.
- It holds only named tabs that run a Claude session: name, session id, working directory, split group.
- A tab you close is removed from it; tabs lost in a crash stay, so they can be restored.
- Whether the file is committed is up to the repository's `.gitignore`.

## How it works

- **Session per tab:** terminal shell process → child `claude` process → `~/.claude*/sessions/<pid>.json`, which Claude Code writes for every running session.
- **Session list:** `~/.claude*/projects/<encoded repo path>*/*.jsonl`, read from the head and tail of each file only.
- **Splits and order:** VS Code does not expose terminal groups to extensions. When a terminal opens or closes, the extension cycles focus through all terminals once and restores focus afterwards (`claudeSessions.autoCaptureLayout`).
- Terminals in the editor area are treated as separate tabs.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `claudeSessions.storageFile` | `.vscode/claude-sessions.json` | State file inside the repository |
| `claudeSessions.claudeCommand` | `claude` | Command used to resume; `--resume <id>` is appended |
| `claudeSessions.openIn` | `activeTerminal` | `activeTerminal` or `newTab` for the ▶ button |
| `claudeSessions.syncSessionName` | `true` | Use tab names as Claude session names |
| `claudeSessions.autoCaptureLayout` | `true` | Capture splits and order automatically |
| `claudeSessions.pollSeconds` | `5` | How often names and sessions are re-read |
| `claudeSessions.historyDays` | `14` | Reach of the Closed list |

## Command line and tests

- `node cli.js list [repo] [--days N] [--json]` lists the sessions of a repository like the Closed folder.
- `npm test` checks session parsing against generated session files.

## Install

```bash
npx -y @vscode/vsce package -o vscode-claude-sessions.vsix
code --install-extension vscode-claude-sessions.vsix --force
```

Then run **Developer: Reload Window**; running terminals survive the reload.

## License

MIT
