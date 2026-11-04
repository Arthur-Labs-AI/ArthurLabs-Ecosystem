#!/usr/bin/env python3
"""RB-04H: metadata-only synchronisation of PCB footprint properties with the schematic fields (text-level edit; no pcbnew, no 'Update PCB').
    python3 rb04h_sync_fields.py --pcb in.kicad_pcb --netlist revb.xml --out out.kicad_pcb --log changes.json
Only these property names are touched: MPN, Manufacturer, LCSC, JLC_Class, BOM_Status, Datasheet.  Existing property values are replaced in place;
missing ones are appended as a hidden F.Fab property cloned from the footprint's own JLC_Class property (same at/layer/hide/effects, new uuid).
Everything else in the file is byte-identical.  Aborts if a footprint has no JLC_Class/MPN property to clone from or a value needs unusual escaping."""
import argparse, json, re, sys, uuid
import xml.etree.ElementTree as ET
ap = argparse.ArgumentParser(); ap.add_argument("--pcb", required=True); ap.add_argument("--netlist", required=True); ap.add_argument("--out", required=True); ap.add_argument("--log", required=True)
a = ap.parse_args()
FIELDS = ["MPN", "Manufacturer", "LCSC", "JLC_Class", "BOM_Status", "Datasheet"]
sch = {}
for c in ET.parse(a.netlist).getroot().iter("comp"):
    d = {fl.get("name"): (fl.text or "") for fl in c.iter("field")}
    d["Datasheet"] = c.findtext("datasheet", d.get("Datasheet", ""))
    sch[c.get("ref")] = d
def esc(v):
    assert "\n" not in v, v
    return v.replace("\\", "\\\\").replace('"', '\\"')
text = open(a.pcb).read()
# split into footprint blocks at one-tab indentation
parts = re.split(r'(?=\n\t\(footprint ")', text)
log = []; out = []
for part in parts:
    if not part.startswith('\n\t(footprint "'):
        out.append(part); continue
    end = part.find("\n\t)\n")
    # block ends at the first line "\t)" at one-tab indent
    m = re.search(r'\n\t\)(?=\n|$)', part)
    blk, rest = part[:m.end()], part[m.end():]
    ref = re.search(r'\(property "Reference" "([^"]+)"', blk).group(1)
    want = sch.get(ref, {})
    for fld in FIELDS:
        if fld not in want: continue
        val = want[fld]
        pat = re.compile(r'(\n\t\t\(property "%s" )"((?:[^"\\]|\\.)*)"' % re.escape(fld))
        mm = pat.search(blk)
        if mm:
            old = mm.group(2).replace('\\"', '"').replace("\\\\", "\\")
            if old != val:
                blk = blk[:mm.start()] + mm.group(1) + '"' + esc(val) + '"' + blk[mm.end():]
                log.append(dict(ref=ref, field=fld, action="replace", old=old, new=val))
        else:
            tmpl = re.search(r'\n\t\t\(property "JLC_Class" "(?:[^"\\]|\\.)*"\n(?:\t\t\t.*\n|\t\t\t\)\n)*?\t\t\)', blk)
            if not tmpl:
                tmpl = re.search(r'\n\t\t\(property "MPN" "(?:[^"\\]|\\.)*"\n(?:\t\t\t.*\n|\t\t\t\)\n)*?\t\t\)', blk)
            assert tmpl, f"no template property in {ref}"
            new = re.sub(r'\(property "[A-Za-z_]+" "(?:[^"\\]|\\.)*"', '(property "%s" "%s"' % (fld, esc(val)), tmpl.group(0), count=1)
            new = re.sub(r'\(uuid "[0-9a-f-]+"\)', '(uuid "%s")' % uuid.uuid4(), new, count=1)
            blk = blk[:tmpl.end()] + new + blk[tmpl.end():]
            log.append(dict(ref=ref, field=fld, action="add", old=None, new=val))
    out.append(blk + rest)
open(a.out, "w").write("".join(out))
json.dump(dict(changes=log, count=len(log)), open(a.log, "w"), indent=1)
import collections
print(len(log), "changes;", dict(collections.Counter((c["field"], c["action"]) for c in log)))
