#!/bin/sh
# usage: shoot.sh <file.html> <query> <out.png> [w] [h]
cd "$(dirname "$0")"
google-chrome-stable --headless=new --no-sandbox --disable-gpu --hide-scrollbars --allow-file-access-from-files --window-size=${4:-1440},${5:-900} --virtual-time-budget=3000 --enable-logging=stderr --v=0 --screenshot="shots/$3" "file://$PWD/$1?$2" 2>&1 | grep -E "CONSOLE|written"
