#!/bin/sh
# usage: shoot.sh <screen-id> [w] [h]   (writes shots/<id>.png)
cd "$(dirname "$0")"
google-chrome-stable --headless=new --no-sandbox --disable-gpu --hide-scrollbars --allow-file-access-from-files --window-size=${2:-1440},${3:-900} --virtual-time-budget=3000 --screenshot="shots/$1.png" "file://$PWD/screens.html?s=$1" 2>&1 | grep -E "written|rror"
