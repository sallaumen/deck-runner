#!/bin/sh
set -eu
cd "$(dirname "$0")"
url=$(python3 -c 'from settings import PORT; print(f"http://127.0.0.1:{PORT}/?screen=1")')
# A restarted station can take a moment to serve the first page.
until curl -fsS --max-time 3 "${url%/?screen=1}/api/status" >/dev/null; do sleep 2; done
exec flatpak run com.google.Chrome \
  --user-data-dir="$HOME/.var/app/com.google.Chrome/config/deck-runner-display" \
  --class=deck-runner --name=deck-runner --ozone-platform=x11 \
  --no-first-run --no-default-browser-check --disable-session-crashed-bubble \
  --app="$url" --start-fullscreen
