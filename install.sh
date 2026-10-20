#!/usr/bin/env bash
# Link the plugins in this repository into the OpenCode plugins directory.
# OpenCode scans that directory on startup, so no entry in plugins[] is needed.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}/plugins"

mkdir -p "$target"

for file in "$here"/plugins/*.ts; do
  name="$(basename "$file")"
  destination="$target/$name"

  if [ -e "$destination" ] && [ ! -L "$destination" ]; then
    backup="$destination.bak-$(date +%Y%m%d-%H%M%S)"
    mv "$destination" "$backup"
    echo "backed up $name -> $backup"
  fi

  ln -sfn "$file" "$destination"
  echo "linked $name -> $destination"
done

echo
echo "Restart OpenCode to load the plugins."
