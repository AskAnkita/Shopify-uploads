#!/bin/bash
# One command for the whole routine.
#   ./update.sh
#
# It stops and tells you what to do whenever a human decision is needed,
# rather than pushing anything half-finished into the store.

set -e
cd "$(dirname "$0")"

# Shopify credentials come from your shell, never from this file.
: "${SHOPIFY_CLIENT_ID:?Set SHOPIFY_CLIENT_ID first:  export SHOPIFY_CLIENT_ID=your_client_id}"
: "${SHOPIFY_CLIENT_SECRET:?Set SHOPIFY_CLIENT_SECRET first:  export SHOPIFY_CLIENT_SECRET=your_secret}"

line() { printf '\n\033[1m%s\033[0m\n' "$1"; }

line "1/4  Looking for items with no title or description yet"
rm -rf ./_identify
node import.js --collect-images

if [ -n "$(ls -A ./_identify 2>/dev/null)" ]; then
  COUNT=$(ls ./_identify | wc -l | tr -d ' ')
  line "STOPPED — $COUNT item(s) need copy before they can be created"
  cat <<MSG

  Previews are in:  $(pwd)/_identify

  Send Claude a message saying "new items to describe" and it will read that
  folder, write the titles and descriptions into product-content.json, and
  tell you to run this again.

  Nothing has been changed in your store.

MSG
  exit 0
fi

line "2/4  Creating anything new"
# Items with no price still get created — as drafts, tagged needs-price, priced 0.
# Fill the price in later and --sync-prices picks it up.
node import.js --live --allow-no-price

line "3/4  Fixing titles and descriptions on anything already in the store"
node import.js --live --sync-content

line "4/4  Checking the store"
node import.js --check

line "Done"
