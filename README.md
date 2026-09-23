# Claude Sessions for VS Code

Keeps Claude Code sessions that run in VS Code terminal tabs restorable. Tab names, order and splits are saved per repository, so after a crash or restart one click brings the named tabs back with `claude --resume`.

## Keywords

vscode, vs code, extension, claude code, terminal tabs, restore tabs, restore sessions, lost sessions, claude resume, tab names, split terminals, session names

## The view

Activity bar → **Claude Sessions** has two sections: **Notifications** (below) and **Sessions** with three folders:

- **active** — terminal tabs of this window in tab order. Splits appear as `split` with their tabs inside; the tab you are on shows an eye icon and `● focused`, every tab shows its state (working, waiting for input, idle).
- **inactive** — every Claude session of this repository that is not running (default: last 30 days).
- **archive** — sessions you archived; collapsed by default. Archiving only hides a session in this list; its files stay untouched.

Every session carries a priority from ① to ⑤ (default ①), shared with the notifications. **inactive** and **archive** sort by priority, then by name.

Buttons:

| Where | Buttons |
|---|---|
| `active` folder | ＋ open a new tab: new Claude session, new terminal, or search an inactive session |
| `split` | ＋ add to this split (same picker) |
| active tab | ↑ ↓ priority · ✎ rename tab and session · ＋ split with this tab (only when not in a split yet) · ✕ close tab |
| inactive / archived session | ↑ ↓ priority · ▶ resume in the active terminal · ＋ resume in a new tab · ✎ rename · archive / move back |

The picker lists new session and new terminal first, then sessions by priority and most recent message; type to search.

▶ resumes in the active terminal: an idle shell runs `claude --resume <id>`, a running Claude switches via `/resume <id>`, a busy terminal gets a new tab instead.

Title bar: **Restore saved tabs** reopens every saved tab that is not running, with its name and split layout.

## Notifications

The **Notifications** section above the session list shows every session in this window that finished (`busy` → `idle`) or is waiting for your input (`waiting`), with name, time and age; after 30 minutes an entry is marked stale.

- **Click** focuses the tab and clears the entry; focusing the tab any other way clears it too.
- **Priority:** every session starts at priority 1; ↓ moves it down (up to 5), ↑ moves it up. The priority is remembered per session and groups the list.
- **Source:** Claude Code writes the status of every running session to `~/.claude*/sessions/<pid>.json`; the extension reads it on every poll.
- The tab you are on is marked `● focused` with an eye icon in the Open folder, next to each tab's state (working, waiting for input, idle).

## Names

- A name you give a terminal tab is saved and also becomes the Claude session name (`/rename <name>`, sent while the session is idle).
- Right-click a tab → **Rename tab (and session)** does both immediately.
- VS Code reports Claude's own title (`✳ …`) through the API rather than a custom tab name; a custom name is recognised as soon as it does not look like a Claude or shell title.

## Naming convention

Default for names given automatically (by an agent or a batch run). Anyone renaming by hand can use any name.

- **Source:** the first message of the session. Name its customer, its general topic or its core task, not what the session drifted into later.
- **Pasted examples are not the topic:** a first message that pastes some output to complain about it is named after the task (`output-fix`), not after the pasted content.
- **Customer work:** just the customer slug (`kreil`, `schmid`); add one word only to distinguish (`kreil-tickets`).
- **Tasks:** noun plus verb or object (`skills-fix`, `vertrag-amerbauer`, `mainufaktur-inbox`).
- **Vague first messages** ("continue", "yes"): fall back to the working directory, then to Claude's title, else `misc`.
- **Recurring automated runs:** `<job>-daily`, e.g. `radar-daily`. Throwaway checks: `test`.
- **Format:** lowercase words joined by hyphens, usually 1–3, at most 5.
- **Never overwrite a name a person gave.** `rename-batch --keep-existing` skips sessions that already carry a name in this format.

## What is saved

- One file per repository: `.vscode/claude-sessions.json`.
- It holds only named tabs that run a Claude session (name, session id, working directory, split group), plus open notifications, session priorities and archive flags.
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
| `claudeSessions.historyDays` | `30` | Reach of the inactive and archive lists |

## Command line and tests

- `node cli.js list [repo] [--days N] [--json]` lists the sessions of a repository.
- `node cli.js rename <session-id> <name>` names a closed session (running sessions are renamed through their tab).
- `node cli.js rename-batch <mapping.json> [--keep-existing]` applies a JSON object `{ "<session-id>": "<name>" }`.
- `npm test` checks session parsing against generated session files.

## Install

```bash
npx -y @vscode/vsce package -o vscode-claude-sessions.vsix
code --install-extension vscode-claude-sessions.vsix --force
```

Then run **Developer: Reload Window**; running terminals survive the reload.

## License

MIT
