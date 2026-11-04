import shutil, subprocess, json, collections
SRC='/home/kaloyan/Projects/A.R.T.H.U.R/hardware/emg/rev-b-xiao/kicad/ARTHUR_EMG_RevB'
V={'R1c_1.9_2.3_m2.05':(2.3,1.9,-0.125),'A2_1.1_1.5_m1.35':(1.5,1.1,-0.075),'A3_0.8_1.2_m1.0':(1.2,0.8,-0.1),'A1_1.4_1.9_m1.65':(1.9,1.4,-0.125)}
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
    assert old in s; open(p,'w').write(s.replace(old,new))
    subprocess.run(['python3','/home/kaloyan/Projects/A.R.T.H.U.R/hardware/emg/rev-b-xiao/tools/rb03_fill.py',p,d+'/f.kicad_pcb'],capture_output=True)
    shutil.move(d+'/f.kicad_pcb',p)
    subprocess.run(['kicad-cli','pcb','drc','--format','json','--severity-all','--schematic-parity','-o',d+'/drc.json',p],capture_output=True,cwd=d)
    j=json.load(open(d+'/drc.json')); c=collections.Counter(f"{v['severity']}:{v['type']}" for v in j['violations'])
    res[name]=dict(drc=dict(c),unconnected=len(j.get('unconnected_items',[]))); print(name,res[name],flush=True)
json.dump(res,open('/tmp/rb04d/exp2.json','w'),indent=1)
