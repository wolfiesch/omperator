#!/usr/bin/env bash
# Pure-GTK4 spike build. Swift 6.3.3 + GTK4 4.22 via pkg-config + a modulemap.
set -euo pipefail
cd "$(dirname "$0")"
CFLAGS=$(pkg-config --cflags gtk4 | awk '{for(i=1;i<=NF;i++) printf "-Xcc %s ", $i}')
eval swiftc main.swift \
  -Xcc -fmodule-map-file=module.modulemap \
  $CFLAGS \
  -lgtk-4 $(pkg-config --libs gtk4) \
  -o spike
echo "built ./spike"
