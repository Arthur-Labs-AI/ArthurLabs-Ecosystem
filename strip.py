import sys, html, re
with open(sys.argv[1], encoding='utf-8', errors='ignore') as f:
    raw = f.read()
text = html.unescape(re.sub(r'<[^>]+>', ' ', raw))
text = re.sub(r'\s+', ' ', text)
print(text)
