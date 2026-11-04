#!/bin/sh
# usage: shoot.sh <preset> [w] [h] [extra query] [out-name]   renders phone.html at exactly w x h (default 390x844)
cd "$(dirname "$0")"
W=${2:-390}; H=${3:-844}; OUT=${5:-$1-$W}
google-chrome-stable --headless=new --no-sandbox --disable-gpu --hide-scrollbars --allow-file-access-from-files --force-device-scale-factor=2 --window-size=$W,$H --virtual-time-budget=${BUDGET:-2500} --enable-logging=stderr --v=0 --screenshot="shots/$OUT.png" "file://$PWD/phone.html?s=$1&w=$W&h=$H$4" 2>&1 | grep -E "mobile-ui|phone.html|written|JS|MISSING"
