# Claude Sessions for VS Code

Keeps Claude Code sessions that run in VS Code terminal tabs restorable. Tab names, order and splits are saved per repository, so after a crash or restart one click brings the named tabs back with `claude --resume`.

## Keywords

vscode, vs code, extension, claude code, terminal tabs, restore tabs, restore sessions, lost sessions, claude resume, tab names, split terminals, session names

## The view

Activity bar → **Claude Sessions** has two sections:

- **Inactive** (top) — every Claude session of this repository that is not running (default: last 30 days). Favorites first in alphabetical order, then the rest newest message first. At the bottom, the folder **archive** (collapsed) holds archived sessions; archiving only hides a session in this list, its files stay untouched.
- **Active** (bottom) — terminal tabs of this window in tab order. Splits appear as `split` with their tabs inside. The icon on the left is the tab's state (⟳ working, ✓ idle, ⊘ exited); the tab you are working in carries a `●` after its name.

Each entry shows only the time of its last message (`last 5 minutes ago`, up to 48 hours, then `22.9.`). The hover holds the rest as a small table (status, folder, last activity, start, session id), followed by the last message and the last reply.

### Notifications

When a session in another tab finishes (`busy` → `idle`) or starts waiting for your input, its row in **Active** turns into a bell with `finished 3 minutes ago` / `waiting for input`, and the **Active** section shows a count badge. Focusing that tab clears it. The status comes from `~/.claude*/sessions/<pid>.json`, which Claude Code writes for every running session.

### Buttons

| Where | Buttons |
|---|---|
| **Active** title bar | ＋ new tab (picker first) · restore saved tabs |
| `split` | ＋ picker first, then a new terminal inside this split |
| active tab | 🔍 search a session and open it in this tab (`/resume`; „New Claude session“ runs `/clear`; refused while the session is working) · ⫼ split: picker first, then a terminal opens directly to the right · ☆/★ favorite and ✎ rename (only for Claude sessions) · ✕ close · 🗑 delete |
| plain terminal (no Claude session) | ＋ picker, runs the choice in this terminal · ⫼ split · ✕ close |
| inactive / archived session | ☆/★ favorite · ▶ resume in the active terminal · ＋ resume in a new tab · ✎ rename · archive / move back · 🗑 delete |

The picker always opens before anything else, so cancelling it (Escape) changes nothing. It offers a new Claude session and a new plain terminal first, then closed favorites newest first, then all other closed sessions newest first, archived last; type to search. Every button explains itself on hover.

🗑 deletes a session completely after a confirmation dialog: its session file(s) and its subfolder go to the system Trash (recoverable from there), and its name, favorite and archive entries are removed. A running session is closed first; one still running in another window is not deleted.

▶ resumes in the active terminal: an idle shell runs `claude --resume <id>`, a running Claude switches via `/resume <id>`, a busy terminal gets a new tab instead.

## Names

- The plugin keeps its own name per session id in the state file; Claude's own session title is not used and nothing is typed into a Claude session.
- Renaming a tab (VS Code's own rename or **Rename tab**) stores the name for that session id; ✎ on an inactive session does the same and renames its tab if it is open.
- A session resumed by its id gets its stored name as tab name, and a tab that still shows Claude's title takes the stored name as soon as it becomes active.
- VS Code reports Claude's own title (`✳ …`) through the API rather than a custom tab name; a custom name is recognised as soon as it does not look like a Claude or shell title.

## Search

- The picker searches while you type; the 🔍 button on **Inactive** filters that list the same way (✕ clears it).
- Every word must occur (case and umlauts ignored). Ranking: a hit in the name or title first, then how often the words occur in the whole conversation, then the most recent session.
- The conversation text of every session (user and Claude messages, not tool output) is cached and filled in the background 5 seconds after start; a warm search over 340 sessions takes about 60 ms.

## Startup

The views render first, from a cache in VS Code's extension storage (`meta-cache.json`, `text-cache.json`), keyed by file and change time; only changed session files are read again. Listing 340 sessions takes about 0.1 s with the cache and 0.75 s without it; details for open tabs load one by one afterwards, and the search text last.

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
- It holds only named tabs that run a Claude session (name, session id, working directory, split group), plus open notifications, favorites and archive flags.
- A tab you close is removed from it; tabs lost in a crash stay, so they can be restored.
- Whether the file is committed is up to the repository's `.gitignore`.

## How it works

- **Session per tab:** terminal shell process → child `claude` process → `~/.claude*/sessions/<pid>.json`, which Claude Code writes for every running session.
- **Session list:** `~/.claude*/projects/<encoded repo path>*/*.jsonl`, read from the head and tail of each file only.
- **Splits and order (automatic):** VS Code does not expose terminal groups to extensions. When a terminal opens or closes, the extension cycles focus through all terminals once and restores focus afterwards (`claudeSessions.autoCaptureLayout`). Every capture is checked against the layout VS Code stores itself (`terminal.integrated.layoutInfo` in the workspace `state.vscdb`, read with `sqlite3`); on a mismatch it captures again more slowly. The same check runs every 10 seconds and when the window regains focus, so splits made by dragging tabs are picked up too — but only after 5 quiet seconds without terminal changes, and at most once per VS Code layout, so the focus never keeps jumping. Captures are logged in the output channel **Claude Sessions**.
- Terminals in the editor area are treated as separate tabs.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `claudeSessions.storageFile` | `.vscode/claude-sessions.json` | State file inside the repository |
| `claudeSessions.claudeCommand` | `claude` | Command used to resume; `--resume <id>` is appended |
| `claudeSessions.openIn` | `activeTerminal` | `activeTerminal` or `newTab` for the ▶ button |
| `claudeSessions.autoCaptureLayout` | `true` | Capture splits and order automatically |
| `claudeSessions.pollSeconds` | `5` | How often names and sessions are re-read |
| `claudeSessions.historyDays` | `30` | Reach of the inactive and archive lists |

## Command line and tests

- `node cli.js list [repo] [--days N] [--json]` lists the sessions of a repository.
- `node cli.js search <query> [repo] [--days N]` runs the same search as the plugin and prints the timing.
- `node cli.js rename <session-id> <name>` names a closed session (running sessions are renamed through their tab).
- `node cli.js rename-batch <mapping.json> [--keep-existing]` applies a JSON object `{ "<session-id>": "<name>" }`.
- `node cli.js archive-duplicates [repo] [--days N]` archives every session whose name also belongs to a newer one; favorites and running sessions stay.
- `node cli.js archive <repo> --name <name> [--days N] [--apply]` archives every session called `<name>` or `<name>-<n>` (e.g. all `misc`); preview unless `--apply`, running sessions are skipped, archiving only sets the flag in the state file.
- `npm test` checks session parsing against generated session files.

## Development procedure

Every change goes through the same steps; a step that fails stops the release.

1. **Test first for every bug:** reproduce the bug as a test in `test/` before fixing it. Logic that touches VS Code goes into small functions that the tests can call with a mocked `vscode` module (see `test/manifest.test.js`).
2. **`npm run verify`:** syntax check of every file plus all tests. `test/manifest.test.js` keeps code and `package.json` in step: every contributed command is registered and vice versa, every view exists in code, every menu entry points to a command, every command hidden from the palette is reachable from a menu or a tree item, every `viewItem` in a `when` clause is produced by the code, and activation in a mocked VS Code registers every command.
3. **Cross-check for flow changes:** anything that changes a user flow (buttons, picker, splits, focus, renames) gets a fresh reviewer that walks the flow in the code, before release.
4. **Release:** package, install, reload the window, then check the changed flow once by hand and read the output channel **Claude Sessions**.
5. **Anything typed into a terminal** (`/resume`, `claude --resume`) is sent only as the direct result of a user action, never automatically.

## Install

```bash
npx -y @vscode/vsce package -o vscode-claude-sessions.vsix
code --install-extension vscode-claude-sessions.vsix --force
```

Then run **Developer: Reload Window**; running terminals survive the reload.

## License

MIT
