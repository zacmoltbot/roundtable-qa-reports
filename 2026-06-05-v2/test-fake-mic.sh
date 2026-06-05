#!/bin/bash
# Test fake microphone with Chromium using the mandarin WAV fixture
# Flags: --use-fake-ui-for-media-stream --use-fake-device-for-media-stream --use-file-for-fake-audio-capture

set -e

WAV="/home/node/.openclaw/workspace/reports/roundtable-qa-fixtures/mandarin-stt-sleep-test.wav"
PROFILE_DIR="/tmp/chromium-fake-mic-test"
OUT_DIR="/home/node/.openclaw/workspace/reports/roundtable-user-qa-2026-06-05-v2/screenshots"
REPORT_DIR="/home/node/.openclaw/workspace/reports/roundtable-user-qa-2026-06-05-v2"

mkdir -p "$PROFILE_DIR"
mkdir -p "$OUT_DIR"

echo "=== Chromium fake mic test ==="
echo "WAV file: $WAV"
echo "WAV size: $(stat -c%s "$WAV") bytes"

# Try to launch chromium with fake device flags
# We need to use CDP to inject the fake device

# First, let's try using chromium directly with headless + fake device flags
echo ""
echo "=== Attempt 1: Direct Chromium with fake device flags ==="

# Use chromium with specific flags to try fake audio capture
timeout 30 chromium \
  --headless=new \
  --no-sandbox \
  --use-fake-ui-for-media-stream \
  --use-fake-device-for-media-stream \
  --use-file-for-fake-audio-capture="$WAV" \
  --user-data-dir="$PROFILE_DIR" \
  --dump-dom \
  "https://roundtable.example.com/group" 2>&1 | head -50 || true

echo ""
echo "=== Attempt 2: Check if we can use Playwright with fake device ==="

# Install playwright if needed
npm list playwright 2>/dev/null || npm install playwright 2>&1 | tail -5

echo ""
echo "=== Attempt 3: Use browser CDP to inject fake stream ==="

# Try via CDP to get/set media streams
echo "Testing CDP Media commands..."