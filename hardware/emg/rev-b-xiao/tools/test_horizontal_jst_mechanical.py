#!/usr/bin/env python3
"""Fault-inject the mechanical checker on scratch boards; run from repo root.
Canonical design files are read-only.
"""
import sys,subprocess,copy,json
from pathlib import Path
sys.path.insert(0,'hardware/emg/rev-b-xiao/tools')
from horizontal_jst_mechanical import *
source=Path('hardware/emg/rev-b-xiao/kicad/ARTHUR_EMG_RevB/ARTHUR_EMG_RevB.kicad_pcb');root=parse(source.read_text());out=[]
for kind in ['bad_pad_width','wrong_rotation','wrong_part','outline_changed']:
 r=copy.deepcopy(root);f=next(f for f in kids(r,'footprint') if props(f)['Reference']=='J101')
 if kind=='bad_pad_width':first(kids(f,'pad')[0],'size')[1]='1.3'
 elif kind=='wrong_rotation':first(f,'at')[3]='90'
 elif kind=='wrong_part':next(p for p in kids(f,'property') if p[1]=='MPN')[2]=Q('WRONG_PART')
 elif kind=='outline_changed':
  for n in r:
   if isinstance(n,list) and first(n,'layer')==['layer','Edge.Cuts']:
    for key in ['start','mid','end']:
     if first(n,key):first(n,key)[1]=str(float(first(n,key)[1])+1)
 p=Path('/tmp/arthur-mech-validation')/(kind+'.kicad_pcb');p.write_text(dump(r)+'\n')
 a=subprocess.run([sys.executable,'hardware/emg/rev-b-xiao/tools/horizontal_jst_mechanical.py','--pcb',str(p),'--out',str(p.with_suffix(''))],capture_output=True,text=True)
 assert a.returncode!=0 and 'AssertionError' in a.stderr,kind
 out.append({'mutation':kind,'rejected':True})
Path('hardware/emg/rev-b-xiao/evidence/horizontal-jst/mechanical-validation/checker-mutations.json').write_text(json.dumps(out,indent=2)+'\n');print('4/4 invalid-board mutations rejected')
