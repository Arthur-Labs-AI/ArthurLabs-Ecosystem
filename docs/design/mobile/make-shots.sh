#!/bin/sh
# Re-renders every screenshot in shots/ from phone.html (headless Chrome, 2x). Needs google-chrome-stable.
cd "$(dirname "$0")"
for p in home home-typing home-recording home-transcribing home-saved home-organizing home-organized home-orgfail home-nopermission home-permission home-denied home-sttfail home-sttterminal home-interrupted \
         ideas ideas-search ideas-long idea idea-long idea-cyrillic idea-offline revise \
         connections-list connections-filtered connections-map connections-node connections-node-open connections-edge \
         evolution evolution-rev evolution-merge evolution-lanes evolution-merge-sheet evolution-pick settings; do ./shoot.sh $p 390 844 "" $p >/dev/null; done
for p in home ideas-long idea-long connections-node evolution-lanes connections-list; do ./shoot.sh $p 360 800 "" $p-360 >/dev/null; done
for p in home connections-list evolution; do ./shoot.sh $p 412 915 "" $p-412 >/dev/null; done
./shoot.sh home 390 844 "&nav=buttons" home-3button >/dev/null
./shoot.sh evolution-rev 390 844 "&nav=buttons" evolution-rev-3button >/dev/null
for p in ideas connections-node home-organizing; do ./shoot.sh $p 390 844 "&theme=light" $p-daylight >/dev/null; done
./shoot.sh home 390 844 "&cap=a" home-variant-a >/dev/null
./shoot.sh home 390 844 "&cap=b" home-variant-b >/dev/null
ls shots | wc -l
