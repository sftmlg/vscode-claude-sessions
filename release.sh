#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
version=$(node -p "require('./package.json').version")
if gh release view "v$version" -R sftmlg/vscode-claude-sessions >/dev/null 2>&1; then
  echo "Release v$version already exists; bump the version in package.json first." >&2
  exit 1
fi
npm run verify
mkdir -p dist
npx -y @vscode/vsce@latest package -o "dist/vscode-claude-sessions-$version.vsix"
git push -q
gh release create "v$version" "dist/vscode-claude-sessions-$version.vsix" -R sftmlg/vscode-claude-sessions --title "v$version" --notes "$(git log -1 --format=%s)"
echo "Released v$version"
