#!/bin/sh
# Compatibility with existing desktop shortcuts.
exec systemctl --user start --no-block deck-runner-display.service
