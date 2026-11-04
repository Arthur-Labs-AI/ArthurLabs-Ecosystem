import re
t = open(r'C:\Users\nikol\AppData\Local\Temp\dsh-217e9p\a2base.net', encoding='utf-8').read()
blocks = re.split(r'\(comp\b', t)[1:]
print('components:', len(blocks))
for b in blocks:
    ref = re.search(r'\(ref ([^)]+)\)', b).group(1)
    val = re.search(r'\(value ([^)]+)\)', b)
    fp = re.search(r'\(footprint ([^)]*)\)', b)
    sheet = re.search(r'\(value "([^"]*)"\)\s*\)\s*\(property\s*\(name "Sheetname"\)\s*\(value "([^"]*)"\)', b)
    s = ref + ' | ' + (val.group(1) if val else '?') + ' | fp:' + (fp.group(1) if fp else '(none)')
    print(s.encode('ascii', 'replace').decode())
