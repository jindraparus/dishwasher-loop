#!/bin/sh
set -eu

if [ -n "${NODE_BINARY:-}" ]; then
  if [ ! -x "$NODE_BINARY" ]; then
    echo "NODE_BINARY is not an executable file: $NODE_BINARY" >&2
    exit 127
  fi
  node_binary=$NODE_BINARY
else
  node_binary=
  for candidate in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /usr/bin/node
  do
    if [ -x "$candidate" ]; then
      node_binary=$candidate
      break
    fi
  done

  if [ -z "$node_binary" ] && command -v node >/dev/null 2>&1; then
    node_binary=$(command -v node)
  fi
fi

if [ -z "$node_binary" ]; then
  echo "Unable to find Node.js. Set NODE_BINARY to the absolute Node.js executable path." >&2
  exit 127
fi

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$node_binary" "$script_directory/../src/mcp/server.js"
