#!/bin/sh
printf 'fake-claude args:'
for a in "$@"; do printf ' [%s]' "$a"; done
printf '\n'
while IFS= read -r line; do
  printf 'got:%s\n' "$line"
done
