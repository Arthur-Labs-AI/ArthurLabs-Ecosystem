#!/bin/bash
curl -sL https://apidog.com/blog/glm-5-3-flash-claude-code-cline/ -o /tmp/glm-guide.html
python3 /mnt/c/Users/merte/Documents/GitHub/Sentry/strip.py /tmp/glm-guide.html | head -c 6000
