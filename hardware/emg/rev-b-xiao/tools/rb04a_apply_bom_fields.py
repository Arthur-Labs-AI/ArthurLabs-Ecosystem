#!/usr/bin/env python3
"""RB-04A: write MPN / Manufacturer / LCSC / JLC_Class / BOM_Status / Datasheet fields into the schematic symbols (text-level edit,
no electrical content touched).  Usage: rb04a_apply_bom_fields.py <kicad dir>"""
import json, re, sys
from pathlib import Path
d = Path(sys.argv[1])
base = Path(__file__).resolve().parent.parent
sel = json.load(open(base / "evidence/rb04a/bom_selection.json"))
by_ref = {}
for l in sel:
    if l["sel"]:
        for r in l["refs"]:
            by_ref[r] = l["sel"]
hide = '(at 0 0 0)\n\t\t\t(hide yes)\n\t\t\t(show_name no)\n\t\t\t(do_not_autoplace no)\n\t\t\t(effects\n\t\t\t\t(font\n\t\t\t\t\t(size 1.27 1.27)\n\t\t\t\t)\n\t\t\t)\n\t\t)'
def setprop(block, name, val):
    val = val.replace('"', "'")
    pat = re.compile(r'(\(property "%s" )"[^"]*"' % re.escape(name))
    if pat.search(block):
        return pat.sub(lambda m: m.group(1) + '"' + val + '"', block, 1)
    # clone position from the JLC_Class property
    m = re.search(r'\t\t\(property "JLC_Class" "[^"]*"\n\t\t\t\(at ([^)]*)\)', block)
    at = m.group(1) if m else "0 0 0"
    new = '\t\t(property "%s" "%s"\n\t\t\t(at %s)\n\t\t\t(hide yes)\n\t\t\t(show_name no)\n\t\t\t(do_not_autoplace no)\n\t\t\t(effects\n\t\t\t\t(font\n\t\t\t\t\t(size 1.27 1.27)\n\t\t\t\t)\n\t\t\t)\n\t\t)\n' % (name, val, at)
    i = block.index('\t\t(property "JLC_Class"')
    return block[:i] + new + block[i:]
tot = 0
for f in sorted(d.glob("*.kicad_sch")):
    s = f.read_text(); out = []; pos = 0; n = 0
    for m in re.finditer(r'\n\t\(symbol\n', s):
        pass
    parts = re.split(r'(?=\n\t\(symbol\n)', s)
    new = []
    for p in parts:
        m = re.search(r'\(property "Reference" "([^"]+)"', p[:3000])
        if p.startswith("\n\t(symbol\n") and m and m.group(1) in by_ref and '(property "JLC_Class"' in p:
            c = by_ref[m.group(1)]
            # block ends at its own closing paren at one-tab indent: this chunk runs until the next top-level symbol; touch only the head part
            end = p.find("\n\t)") + 3
            blk, rest = p[:end], p[end:]
            blk = setprop(blk, "MPN", c["mpn"])
            blk = setprop(blk, "Manufacturer", c["mfr"])
            blk = setprop(blk, "JLC_Class", c["cls"])
            blk = setprop(blk, "LCSC", c["lcsc"])
            blk = setprop(blk, "BOM_Status", c["status"] + (" - " + c["note"] if c["status"].startswith("PENDING") else ""))
            blk = setprop(blk, "Datasheet", "https://www.lcsc.com/datasheet/%s.pdf" % c["lcsc"])
            p = blk + rest; n += 1
        new.append(p)
    f.write_text("".join(new)); tot += n
    print(f.name, n)
print("symbols updated", tot, "refs covered", len(by_ref))
