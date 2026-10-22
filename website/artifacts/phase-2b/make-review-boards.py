from pathlib import Path
from PIL import Image,ImageDraw,ImageChops,ImageStat
import json,math,hashlib
p=Path('artifacts/phase-2b')
for width in [390,768,1440,1920]:
 names=['hero','capture','orchestrate','verify','consolidate','return','architecture','products','hardware','availability']
 s=Image.new('RGB',(960,5*394),'#17181a');d=ImageDraw.Draw(s)
 for i,name in enumerate(names):
  im=Image.open(p/f'suite-{width}-{name}.png').convert('RGB');im.thumbnail((480,360));x=i%2*480;y=i//2*394;d.text((x+10,y+6),f'{width}px / {name}',fill='white');s.paste(im,(x,y+28))
 s.save(p/f'review-sheet-{width}.jpg',quality=92)
for width,cellw,cellh in [(1440,360,250),(390,195,422)]:
 s=Image.new('RGB',(cellw*4,(cellh+44)*4),'#17181a');d=ImageDraw.Draw(s)
 for row,route in enumerate(['studio-nexus','nexus-sentry','sentry-nexus','nexus-studio']):
  for col,suffix in enumerate(['1','2','mid','3']):
   im=Image.open(p/f'suite-{width}-{route}-{suffix}.png').convert('RGB');im.thumbnail((cellw,cellh));x=col*cellw;y=row*(cellh+44);d.text((x+8,y+8),f'{route} / {suffix}',fill='white');s.paste(im,(x,y+32))
 s.save(p/f'transition-sequence-{width}.jpg',quality=94)
for width in [390,1440]:
 for name in ['hero','orchestrate']:
  before=Image.open(f'artifacts/phase-2a/suite-{width}-{name}.png').convert('RGB');after=Image.open(p/f'suite-{width}-{name}.png').convert('RGB')
  before.thumbnail((720,1000));after.thumbnail((720,1000));s=Image.new('RGB',(before.width+after.width,max(before.height,after.height)+35),'#17181a');d=ImageDraw.Draw(s);d.text((10,10),'PHASE 2A',fill='white');d.text((before.width+10,10),'PHASE 2B',fill='white');s.paste(before,(0,35));s.paste(after,(before.width,35));s.save(p/f'comparison-{width}-{name}.jpg',quality=94)
metrics=json.loads((p/'motion-measurements.json').read_text());summary=[]
for width in [390,768,1440,1920]:
 rows=[r for r in metrics if r.get('width')==width and 'p'in r];hand=[]
 for route in ['studio-nexus','nexus-sentry','sentry-nexus','nexus-studio']:
  a=next(r for r in rows if r['name']==route+'-1');b=next(r for r in rows if r['name']==route+'-mid');c=next(r for r in rows if r['name']==route+'-3');ar=a['document']['rect'];br=b['document']['rect'];cr=c['document']['rect'];reverse=next(r for r in rows if r['name']==f"reverse-{b['p']}");rr=reverse['document']['rect']
  hand.append({'route':route,'scrollY':[a['y'],b['y'],c['y']],'timeline':[a['timeline'],b['timeline'],c['timeline']],'early_to_mid_distance':round(math.hypot(br['x']-ar['x'],br['y']-ar['y']),2),'mid_to_late_distance':round(math.hypot(br['x']-cr['x'],br['y']-cr['y']),2),'reverse_mid_delta':round(math.hypot(rr['x']-br['x'],rr['y']-br['y']),2),'mid_panel_opacities':[float(v['opacity']) for v in b['panels']]})
 summary.append({'width':width,'handoffs':hand,'overflow_samples':[r['name'] for r in rows if r['overflow']],'uncontained_documents':[r['name'] for r in rows if 0<r['p']<1 and (r['document']['rect']['x']<0 or r['document']['rect']['right']>width)],'blank_pin_samples':[r['name'] for r in rows if 0<=r['p']<=1 and abs(r['pin']['y'])>1]})
(p/'motion-summary.json').write_text(json.dumps(summary,indent=2))
reg=[]
for width in [390,1440]:
 a=Image.open(f'artifacts/phase-2a/landing-{width}-regression.png').convert('RGB');b=Image.open(p/f'landing-{width}-regression.png').convert('RGB');diff=ImageChops.difference(a,b);reg.append({'width':width,'rms':ImageStat.Stat(diff).rms,'identical':diff.getbbox()is None})
(p/'landing-comparison.json').write_text(json.dumps(reg,indent=2))
protected=json.loads(Path('artifacts/phase-2a/preserved-files.json').read_text());(p/'preservation-result.json').write_text(json.dumps({'checked':len(protected),'changed':[f for f,h in protected.items() if hashlib.sha256(Path(f).read_bytes()).hexdigest()!=h]},indent=2))
files=[Path('src/app/suite/page.tsx'),*Path('src/components/suite').glob('*'),Path('tests/suite.spec.ts'),Path('tests/suite-motion.spec.ts'),Path('tests/capture-suite-motion.mjs')]
(p/'source-manifest.json').write_text(json.dumps({str(f):hashlib.sha256(f.read_bytes()).hexdigest()for f in files},indent=2));print(json.dumps(summary,indent=2))
