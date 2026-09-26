# Claude Sessions for VS Code

Keeps Claude Code sessions that run in VS Code terminal tabs restorable. Tab names, order and splits are saved per repository, so after a crash or restart one click brings the named tabs back with `claude --resume`.

## Keywords

vscode, vs code, extension, claude code, terminal tabs, restore tabs, restore sessions, lost sessions, claude resume, tab names, split terminals, session names

## The view

Activity bar → **Claude Sessions** has two sections:

- **Inactive** (top) — every Claude session of this repository that is not running (default: last 30 days). Favorites first in alphabetical order, then the rest newest message first. At the bottom, the folder **archive** (collapsed) holds archived sessions; archiving only hides a session in this list, its files stay untouched.
- **Active** (bottom) — terminal tabs of this window in tab order. Splits appear as `split` with their tabs inside. The icon on the left is the tab's state (⟳ working, ✓ idle, ⊘ exited); the tab you are working in carries a `●` after its name.

Clicking an inactive or archived session opens its session file (JSONL) in the editor; clicking an active tab focuses that tab, its context menu opens the file.

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

The views render first, from a cache in VS Code's extension storage (`meta-cache.json`, `text-cache.json`), keyed by file and change time; only changed session files are read again. Listing 340 sessions takes about 0.1 s with the cache and 0.75 s without it; details for open tabs load one by one afterwards, and the search text last. The search text cache is written at most once a minute, the list cache every few seconds. **Active** renders once, when the restored terminals, their sessions and their details are known; until then VS Code shows its loading bar. Every view redraws at most every 50 ms, however many changes arrive.

The extension shares one extension host with every other installed extension. Extensions that search the whole workspace on start (`workspaceContains` activation) or start language tools can hold that host for several seconds; the extension host log (`Developer: Show Logs…` → Extension Host) shows which ones run. `npm run bench -- <repo>` measures the extension's own share on real data.

## Timing rules

One rule per kind of trigger; a new trigger joins the matching row instead of getting its own timer.

| Trigger | Rule |
|---|---|
| Clicks, buttons, commands | Immediate, never delayed |
| Redraw of a view | At most one per 50 ms (`SessionsProvider.refresh`) |
| Session list from disk | Only when the set of running Claude sessions changes, a tab is saved or removed, or a command changes names, favorites or archive; a busy/idle change only redraws |
| Terminal opened | Collected; acted on after 1.5 s without a new one (one check for one terminal, one capture for several) |
| Terminal closed | Removed from its split at once, then one poll; focus never moves |
| Start | Waits until restored terminals are quiet for 1.5 s, then draws **Active** once |
| Poll of running sessions | Every `pollSeconds` (5 s); a poll requested while one runs is queued, not run in parallel |
| Search fields | 150 ms (picker) and 200 ms (Inactive search) after the last keystroke |
| Caches on disk | List cache 5 s, search text cache 60 s after the last change |
| Relative times ("5 min ago") | Redraw every 60 s |
| Updates | 30 s after start, then hourly; each version installed once |
| Nextcloud sync | 3 s after **Active** is drawn, every 10 minutes, and 5 s after the last star change; never two at once |

## Sync across machines (Nextcloud)

Favorite sessions — open or closed — follow you to your other machines through a folder in your own Nextcloud.

- **Connect:** `Claude Sessions: Connect Nextcloud` (plug in the **Inactive** menu) asks for the Nextcloud address and opens its login page in the browser. You sign in the way your Nextcloud offers — single sign-on included — and grant access to *Claude Sessions (VS Code)*. Nextcloud hands the extension an app password, kept in VS Code's secret storage; no password is typed into VS Code.
- **Without a login click:** `claudeSessions.sync.credentialsFile` points to a JSON file with `server`, `loginName` and `appPassword`, as written by `node cli.js sync login <url> --credentials <file>`. Used only while no connection is stored.
- **Where:** `<your files>/Claude Sessions/<repository folder name>/` — one `<session-id>.jsonl` per favorite plus `state.json` with the stars and names. The folder is created in your own files and is not shared; nobody else sees it unless you share it in Nextcloud.
- **What moves:** only sessions with a star. Other sessions stay on their machine.
- **Direction:** the newer file wins, compared by modification time, which travels with the file. A session that runs on this machine is never overwritten by a download; the next sync after it ends catches up.
- **Stars and names:** merged against the state of the last sync, so a star added on one machine appears on the other and a star removed on one machine disappears on the other (its file is removed from the Nextcloud folder, never from a machine). Names given on this machine win over incoming ones.
- **Second machine:** open the same repository (any path, same folder name), connect, and the favorites appear in **Inactive** with their stars and names; ▶ resumes them with `claude --resume`.
- **Buttons:** sync now (in the **Inactive** header once connected), connect and disconnect in the header menu.
- **Security:** session files contain whatever was said and pasted in a session, including secrets. Sync only to a Nextcloud you control, keep the folder unshared, and disconnect a machine you give away (`Disconnect Nextcloud`, then revoke the app password under Nextcloud → Settings → Security).
- **End-to-end check against a real Nextcloud:** `node e2e/nextcloud-e2e.mjs --credentials <file> --repo <path>` measures refusal without login, completeness, byte identity, ownership, the absence of any share, and a simulated second machine that receives everything and lists it. Exit 1 when any check fails.

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
- **Splits and order:** VS Code does not expose terminal groups to extensions. The extension keeps its own copy and moves focus as little as possible (`claudeSessions.autoCaptureLayout`, on by default):
  - **One quiet period for everything:** terminal events are collected and acted on only after 1.5 s without a new one, on start as later.
  - **On start,** once the restored terminals have been quiet for 1.5 s and before **Active** is drawn, the layout VS Code saved itself (`terminal.integrated.layoutInfo` in the workspace `state.vscdb`, read with `sqlite3`) is applied in terminal order, then focus cycles through all terminals once to confirm it and returns.
  - **Terminals the extension opens** (split button, ＋, restore, resume) are placed directly, without any focus change.
  - **Terminals you open yourself:** after the quiet period, a single one gets one check (focus to the previous pane of its split and back; a plain new terminal has no previous pane, so nothing visibly moves); several at once get one full capture.
  - **Order inside a split:** a capture learns which panes belong together and their order up to rotation. The first pane is the one already known as first (from a split the extension made, a check or the saved layout); only without that does the oldest terminal go first.
  - **Closing a terminal** only removes it from its split; focus never moves.
  - `Claude Sessions: Capture split layout` in the command palette captures by hand, e.g. after dragging terminals between splits. Captures are logged in the output channel **Claude Sessions**.
- Terminals in the editor area are treated as separate tabs.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `claudeSessions.storageFile` | `.vscode/claude-sessions.json` | State file inside the repository |
| `claudeSessions.claudeCommand` | `claude` | Command used to resume; `--resume <id>` is appended |
| `claudeSessions.openIn` | `activeTerminal` | `activeTerminal` or `newTab` for the ▶ button |
| `claudeSessions.autoCaptureLayout` | `true` | Capture splits on start and place terminals you open yourself (see Splits and order) |
| `claudeSessions.pollSeconds` | `5` | How often names and sessions are re-read |
| `claudeSessions.historyDays` | `30` | Reach of the inactive and archive lists |
| `claudeSessions.sync.server` | empty | Nextcloud address, set by Connect Nextcloud |
| `claudeSessions.sync.folder` | `Claude Sessions` | Folder in your Nextcloud files |
| `claudeSessions.sync.auto` | `true` | Sync on start, every 10 minutes and after star changes; off = only Sync now |
| `claudeSessions.sync.credentialsFile` | empty | App-password file used when no connection is stored |

## Command line and tests

- `node cli.js list [repo] [--days N] [--json]` lists the sessions of a repository.
- `node cli.js search <query> [repo] [--days N]` runs the same search as the plugin and prints the timing.
- `node cli.js rename <session-id> <name>` names a closed session (running sessions are renamed through their tab).
- `node cli.js rename-batch <mapping.json> [--keep-existing]` applies a JSON object `{ "<session-id>": "<name>" }`.
- `node cli.js archive-duplicates [repo] [--days N]` archives every session whose name also belongs to a newer one; favorites and running sessions stay.
- `node cli.js archive <repo> --name <name> [--days N] [--apply]` archives every session called `<name>` or `<name>-<n>` (e.g. all `misc`); preview unless `--apply`, running sessions are skipped, archiving only sets the flag in the state file.
- `node cli.js sync login <nextcloud-url> --credentials <file>` runs the browser login and writes the app password to `<file>`; `node cli.js sync [repo] --credentials <file>` runs the same favorite sync as the plugin; `node cli.js sync check --credentials <file>` exits 0 while the app password is accepted.
- `npm test` checks session parsing against generated session files and walks user flows (favorites, close, rename, splits, picker) in a fake VS Code (`test/fake-vscode.js`) with stand-in Claude processes.
- `npm run bench -- [repo]` times cache load, session list, search index, search and the first render on real data.

## Development procedure

Every change goes through the same steps; a step that fails stops the release.

1. **Test first for every bug:** reproduce the bug as a test in `test/` before fixing it. Flows that click through the views go into `test/flows.test.js` on the fake VS Code; tree rows carry stable ids so a click on a row that was just refreshed still reaches its command.
2. **`npm run verify`:** syntax check of every file plus all tests. `test/manifest.test.js` keeps code and `package.json` in step: every contributed command is registered and vice versa, every view exists in code, every menu entry points to a command, every command hidden from the palette is reachable from a menu or a tree item, every `viewItem` in a `when` clause is produced by the code, and activation in a mocked VS Code registers every command.
3. **Cross-check for flow changes:** anything that changes a user flow (buttons, picker, splits, focus, renames) gets a fresh reviewer that walks the flow in the code, before release.
4. **Release:** bump `version` in `package.json`, commit, then `npm run release` (verify, package, push, GitHub release with the `.vsix`). Every installed copy picks the release up within an hour; check the changed flow once by hand and read the output channel **Claude Sessions**.
5. **Anything typed into a terminal** (`/resume`, `claude --resume`) is sent only as the direct result of a user action, never automatically.

## Updates

The extension checks the latest GitHub release of `sftmlg/vscode-claude-sessions` 30 seconds after start and then every hour (`claudeSessions.autoUpdate`). A newer release is downloaded and installed automatically, once per version; a notification with a **Reload** button appears and the **Inactive** header shows `updated to <version> · reload to use it`. The new version runs only after the window reloads; terminals and Claude sessions keep running through a reload. The cloud button in the same header checks immediately.

## Install

```bash
npx -y @vscode/vsce package -o vscode-claude-sessions.vsix
code --install-extension vscode-claude-sessions.vsix --force
```

Then run **Developer: Reload Window**; running terminals survive the reload.

## License

MIT
