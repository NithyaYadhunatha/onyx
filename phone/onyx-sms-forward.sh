#!/data/data/com.termux/files/usr/bin/bash
# Forward new SMS from this Android phone to Onyx on your PC, over home Wi-Fi.
#
# Needs Termux and Termux:API (both free and open source, from F-Droid), and
# `pkg install termux-api jq curl`. See phone/README.md.
#
#   ONYX_URL=http://192.168.1.20:8766 ONYX_TOKEN=... bash onyx-sms-forward.sh
#
# It checks every minute, remembers what it already sent, and only ever sends
# SMS to the address you give it.

set -u
: "${ONYX_URL:?set ONYX_URL, e.g. http://192.168.1.20:8766}"
: "${ONYX_TOKEN:?set ONYX_TOKEN (from the pairing link: the part after #t=)}"
STATE="${HOME}/.onyx-sms-last"
INTERVAL="${INTERVAL:-60}"

# Termux gives local times like "2026-10-12 14:30:11", which sort as text.
last=$(cat "$STATE" 2>/dev/null || echo "0000-00-00 00:00:00")
termux-wake-lock 2>/dev/null || true
echo "Forwarding SMS newer than $last to $ONYX_URL every ${INTERVAL}s. Ctrl+C to stop."

while true; do
  # Newest 50 inbox messages as JSON; keep those newer than the last one sent.
  batch=$(termux-sms-list -l 50 -t inbox 2>/dev/null | jq --arg last "$last" '
    [ .[] | {address: .number, body: .body, received: .received} | select(.received > $last) ]')
  count=$(echo "${batch:-[]}" | jq 'length' 2>/dev/null || echo 0)
  if [ "${count:-0}" -gt 0 ]; then
    if curl -sf -m 20 -X POST "$ONYX_URL/ingest/sms" \
         -H "Authorization: Bearer $ONYX_TOKEN" -H "Content-Type: application/json" \
         -d "{\"messages\": $batch}" >/dev/null; then
      last=$(echo "$batch" | jq -r 'map(.received) | max')
      echo "$last" > "$STATE"
      echo "$(date +%H:%M) sent $count SMS"
    else
      echo "$(date +%H:%M) Onyx not reachable; will retry"
    fi
  fi
  sleep "$INTERVAL"
done
