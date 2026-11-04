#!/usr/bin/env python3
"""RB-03: fill all copper zones of a board with pcbnew and save.   python3 rb03_fill.py in.kicad_pcb out.kicad_pcb"""
import sys
import pcbnew
import sys as _sys, pathlib as _pl
_sys.path.insert(0, str(_pl.Path(__file__).resolve().parent))
from rb03r_safe import safe_pcb  # noqa: E402
b = pcbnew.LoadBoard(str(safe_pcb(sys.argv[1])))
for z in b.Zones():
    if not z.GetIsRuleArea():
        z.SetLocalClearance(int(0.30 * 1e6))        # >= every netclass clearance (0.30 mm for ELECTRODE / VBUS_SENSE)
f = pcbnew.ZONE_FILLER(b)
f.Fill(b.Zones())
pcbnew.SaveBoard(sys.argv[2], b)
print("filled zones:", sum(1 for z in b.Zones() if not z.GetIsRuleArea()))
