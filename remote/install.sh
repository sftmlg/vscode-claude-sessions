#!/bin/bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: remote/install.sh [--root <dir>]... [--default-dir <dir>] [--launcher <path> [--launcher-arg <arg>]...]
                         [--claude-arg <arg>]... [--dry-run] [--no-check] [--uninstall]
Installs the claude-remote LaunchAgent for the current user, writes the config, exposes the
loopback port with `tailscale serve --http` (never Funnel) and runs a self-check.
--uninstall removes the LaunchAgent and this service's serve port; config and state stay.
EOF
}

LABEL="com.claude-remote.hub"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
CONFIG_FILE="${CLAUDE_REMOTE_CONFIG:-$HOME/.config/claude-remote/config.json}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
CHILD_PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

ROOTS=()
LAUNCHER=()
CLAUDE_ARGS=()
DEFAULT_DIR=""
LAUNCHER_SET=0
CLAUDE_ARGS_SET=0
DRY_RUN=0
CHECK=1
UNINSTALL=0

need_value() {
  if [ $# -lt 2 ] || [ -z "$2" ]; then echo "Missing value for $1" >&2; exit 2; fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --root) need_value "$@"; ROOTS+=("$2"); shift 2 ;;
    --default-dir) need_value "$@"; DEFAULT_DIR="$2"; shift 2 ;;
    --launcher) need_value "$@"; LAUNCHER=("$2"); LAUNCHER_SET=1; shift 2 ;;
    --launcher-arg) need_value "$@"; [ "$LAUNCHER_SET" = 1 ] || { echo "--launcher-arg needs --launcher first" >&2; exit 2; }; LAUNCHER+=("$2"); shift 2 ;;
    --claude-arg) need_value "$@"; CLAUDE_ARGS+=("$2"); CLAUDE_ARGS_SET=1; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --no-check) CHECK=0; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

act() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '+'; printf ' %q' "$@"; printf '\n'
  else
    "$@"
  fi
}

say() { printf '%s\n' "$*"; }

if [ "$(uname -s)" != "Darwin" ]; then echo "macOS only." >&2; exit 1; fi

NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "node not found on PATH." >&2; exit 1; }
NODE="$(cd "$(dirname "$NODE")" && pwd -P)/$(basename "$NODE")"

TAILSCALE="$(command -v tailscale || true)"
if [ -z "$TAILSCALE" ] && [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then
  TAILSCALE=/Applications/Tailscale.app/Contents/MacOS/Tailscale
fi
[ -n "$TAILSCALE" ] || { echo "tailscale CLI not found." >&2; exit 1; }

TMUX_BIN="$(command -v tmux || true)"
for candidate in /opt/homebrew/bin/tmux /usr/local/bin/tmux; do
  [ -n "$TMUX_BIN" ] || { [ -x "$candidate" ] && TMUX_BIN="$candidate"; } || true
done
[ -n "$TMUX_BIN" ] || { echo "tmux not found." >&2; exit 1; }
TMUX_BIN="$(cd "$(dirname "$TMUX_BIN")" && pwd -P)/$(basename "$TMUX_BIN")"

LAUNCHCTL="$(command -v launchctl || echo /bin/launchctl)"
GUI="gui/$(id -u)"

resolve() {
  CLAUDE_REMOTE_CONFIG="$1" "$NODE" -e '
    const { loadConfig } = require(process.argv[1]);
    const c = loadConfig({ file: process.env.CLAUDE_REMOTE_CONFIG, overrides: process.argv[2] ? { stateDir: process.argv[2] } : {} });
    console.log([c.port, c.publicPort, c.stateDir].join("\n"));
  ' "$REPO_DIR/remote/config.js" "${2:-}"
}

if [ "$UNINSTALL" = 1 ]; then
  PUBLIC_PORT="$(resolve "$CONFIG_FILE" "$(mktemp -d)" | sed -n 2p)"
  act "$LAUNCHCTL" bootout "$GUI/$LABEL" || true
  act rm -f "$PLIST"
  act "$TAILSCALE" serve --http="$PUBLIC_PORT" off || true
  say "Removed the LaunchAgent and serve port $PUBLIC_PORT. Config ($CONFIG_FILE) and state stay."
  exit 0
fi

STATUS_JSON="$("$TAILSCALE" status --json)"
MEASURED="$(printf '%s' "$STATUS_JSON" | "$NODE" -e '
  let s = ""; process.stdin.on("data", (c) => (s += c)).on("end", () => {
    const j = JSON.parse(s);
    const self = j.Self || {};
    const host = String(self.DNSName || "").replace(/\.$/, "");
    const user = (j.User || {})[String(self.UserID)] || {};
    if (!host || !user.LoginName) { console.error("tailscale status has no DNS name or login for this node"); process.exit(1); }
    console.log(host + "\n" + user.LoginName);
  });
')"
PUBLIC_HOST="$(printf '%s\n' "$MEASURED" | sed -n 1p)"
ALLOWED_LOGIN="$(printf '%s\n' "$MEASURED" | sed -n 2p)"
say "Measured public host (${#PUBLIC_HOST} chars) and allowed login (${#ALLOWED_LOGIN} chars)."

MERGED="$(mktemp)"
trap 'rm -f "$MERGED"' EXIT
"$NODE" -e '
  const fs = require("fs");
  const [file, out, host, login, tmuxPath, defaultDir, launcherSet, claudeArgsSet, ...rest] = process.argv.slice(1);
  const sep = rest.indexOf("--"), sep2 = rest.indexOf("--", sep + 1);
  const roots = rest.slice(0, sep), launcher = rest.slice(sep + 1, sep2), claudeArgs = rest.slice(sep2 + 1);
  let c = {};
  try { c = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; }
  c.publicHost = host;
  c.allowedLogin = login;
  c.tmuxPath = tmuxPath;
  if (roots.length) c.roots = roots.map((r) => fs.realpathSync(r));
  if (defaultDir) c.defaultDir = fs.realpathSync(defaultDir);
  if (launcherSet === "1") c.launcher = launcher;
  if (claudeArgsSet === "1") c.claudeArgs = claudeArgs;
  fs.writeFileSync(out, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
' "$CONFIG_FILE" "$MERGED" "$PUBLIC_HOST" "$ALLOWED_LOGIN" "$TMUX_BIN" "$DEFAULT_DIR" "$LAUNCHER_SET" "$CLAUDE_ARGS_SET" \
  ${ROOTS[@]+"${ROOTS[@]}"} -- ${LAUNCHER[@]+"${LAUNCHER[@]}"} -- ${CLAUDE_ARGS[@]+"${CLAUDE_ARGS[@]}"}

if [ "$DRY_RUN" = 1 ]; then
  RESOLVED="$(resolve "$MERGED" "$(mktemp -d)")"
  STATE_DIR="$("$NODE" -e '
    const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const { expandHome } = require(process.argv[2]);
    console.log(expandHome(c.stateDir || "~/.local/state/claude-remote", require("os").homedir()));
  ' "$MERGED" "$REPO_DIR/remote/config.js")"
else
  RESOLVED="$(resolve "$MERGED")"
  STATE_DIR="$(printf '%s\n' "$RESOLVED" | sed -n 3p)"
fi
PORT="$(printf '%s\n' "$RESOLVED" | sed -n 1p)"
PUBLIC_PORT="$(printf '%s\n' "$RESOLVED" | sed -n 2p)"

act mkdir -p "$(dirname "$CONFIG_FILE")"
act chmod 700 "$(dirname "$CONFIG_FILE")"
act install -m 600 "$MERGED" "$CONFIG_FILE"
act mkdir -p "$STATE_DIR"
act chmod 700 "$STATE_DIR"
for log in server.out.log server.err.log; do
  act touch "$STATE_DIR/$log"
  act chmod 600 "$STATE_DIR/$log"
done

(cd "$REPO_DIR" && act npm ci --omit=dev --ignore-scripts)

RENDERED="$(mktemp)"
trap 'rm -f "$MERGED" "$RENDERED"' EXIT
# shellcheck disable=SC2016
"$NODE" -e '
  const fs = require("fs");
  const [template, out, ...pairs] = process.argv.slice(1);
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  let x = fs.readFileSync(template, "utf8");
  for (let i = 0; i < pairs.length; i += 2) x = x.split(`{{${pairs[i]}}}`).join(esc(pairs[i + 1]));
  if (/\{\{[A-Z_]+\}\}/.test(x)) { console.error("unrendered placeholder in plist template"); process.exit(1); }
  fs.writeFileSync(out, x);
' "$SCRIPT_DIR/launchd/claude-remote.plist.template" "$RENDERED" \
  LABEL "$LABEL" NODE "$NODE" SERVER "$REPO_DIR/remote/server.js" WORKDIR "$REPO_DIR" \
  PATH "$CHILD_PATH" CONFIG "$CONFIG_FILE" STATE_DIR "$STATE_DIR"
/usr/bin/plutil -lint -s "$RENDERED"

act mkdir -p "$(dirname "$PLIST")"
act install -m 644 "$RENDERED" "$PLIST"
act "$LAUNCHCTL" bootout "$GUI/$LABEL" 2>/dev/null || true
act "$LAUNCHCTL" bootstrap "$GUI" "$PLIST"
act "$TAILSCALE" serve --bg --http="$PUBLIC_PORT" "http://127.0.0.1:$PORT"

if [ "$DRY_RUN" = 1 ]; then
  say "Dry run: nothing was changed. Rendered LaunchAgent:"
  cat "$RENDERED"
  exit 0
fi

if [ "$CHECK" = 1 ]; then
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if CLAUDE_REMOTE_CONFIG="$CONFIG_FILE" "$NODE" "$REPO_DIR/remote/cli.js" status >/dev/null 2>&1; then
      say "Self-check passed."
      exit 0
    fi
    /bin/sleep 1
  done
  CLAUDE_REMOTE_CONFIG="$CONFIG_FILE" "$NODE" "$REPO_DIR/remote/cli.js" status || true
  echo "Self-check failed." >&2
  exit 1
fi
say "Installed; self-check skipped."
