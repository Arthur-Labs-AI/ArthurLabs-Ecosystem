import shutil, subprocess, sys, json, re, os, collections
SRC='/home/kaloyan/Projects/A.R.T.H.U.R/hardware/emg/rev-b-xiao/kicad/ARTHUR_EMG_RevB'
V={'V0_base':(1.9,1.4,-0.225),'V1_h1.6':(2.0,1.6,-0.175),'V2_h1.7':(2.1,1.7,-0.175),'V3_h1.8':(2.2,1.8,-0.175)}
res={}
for name,(ring,drill,mm) in V.items():
    d=f'/tmp/rb04d/{name}'; shutil.rmtree(d,ignore_errors=True); shutil.copytree(SRC,d,ignore=shutil.ignore_patterns('.history','*.lck')); subprocess.run(['chmod','-R','u+w',d])
    p=d+'/ARTHUR_EMG_RevB.kicad_pcb'; s=open(p).read()
    old='''(pad "23" thru_hole circle
			(at -4.445 -0.4075 180)
			(size 1.9 1.9)
			(drill 1.4)
			(layers "*.Cu" "*.Mask")
			(remove_unused_layers no)
			(net "VBAT")
			(solder_mask_margin -0.225)'''
    new=old.replace('(size 1.9 1.9)',f'(size {ring} {ring})').replace('(drill 1.4)',f'(drill {drill})').replace('-0.225)',f'{mm})')
    assert old in s; s=s.replace(old,new); open(p,'w').write(s)
    r=subprocess.run(['python3','/home/kaloyan/Projects/A.R.T.H.U.R/hardware/emg/rev-b-xiao/tools/rb03_fill.py',p,d+'/filled.kicad_pcb'],capture_output=True,text=True)
    shutil.move(d+'/filled.kicad_pcb',p)
    r=subprocess.run(['kicad-cli','pcb','drc','--format','json','--severity-all','--schematic-parity','-o',d+'/drc.json',p],capture_output=True,text=True,cwd=d)
    j=json.load(open(d+'/drc.json'))
    c=collections.Counter((v['severity'],v['type']) for v in j['violations'])
    res[name]=dict(drc=dict((f'{a}:{b}',n) for (a,b),n in c.items()),unconnected=len(j.get('unconnected_items',[])))
    print(name,res[name],flush=True)
json.dump(res,open('/tmp/rb04d/exp.json','w'),indent=1)
