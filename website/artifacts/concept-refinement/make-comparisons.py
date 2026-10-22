from pathlib import Path
from PIL import Image,ImageDraw
import json,hashlib,math
p=Path('artifacts/concept-refinement')
for width in[390,1440]:
 for name in['begin','knowledge','end']:
  a=Image.open(p/f'before-{width}-{name}.png').convert('RGB');b=Image.open(p/f'concept-{width}-{name}.png').convert('RGB');a.thumbnail((720,1000));b.thumbnail((720,1000));s=Image.new('RGB',(a.width+b.width,max(a.height,b.height)+36),'#111411');d=ImageDraw.Draw(s);d.text((12,10),'BEFORE / RASTER BACKDROP',fill='white');d.text((a.width+12,10),'AFTER / DOM + SVG',fill='white');s.paste(a,(0,36));s.paste(b,(a.width,36));s.save(p/f'comparison-{width}-{name}.jpg',quality=94)
for width in[390,768,1440,1920]:
 names=['begin','knowledge','plan','end'];w=390 if width==390 else 480;h=844 if width==390 else 350;s=Image.new('RGB',(w*4,h+35),'#111411');d=ImageDraw.Draw(s)
 for i,n in enumerate(names):
  im=Image.open(p/f'concept-{width}-{n}.png').convert('RGB');im.thumbnail((w,h));d.text((i*w+12,10),n.upper(),fill='white');s.paste(im,(i*w,35))
 s.save(p/f'concept-{width}-storyboard.jpg',quality=94)
rows=json.loads((p/'measurements.json').read_text());old=json.loads(Path('artifacts/suite-concept/measurements.json').read_text());summary=[]
for width in[390,768,1440,1920]:
 cur=[r for r in rows if r.get('width')==width and 'name'in r];comparison=[]
 for r in cur:
  original=next(o for o in old if o.get('width')==width and o.get('name')==r['name'])
  comparison += [math.hypot(n['rect']['x']-m['rect']['x'],n['rect']['y']-m['rect']['y'])for n,m in zip(r['nodes'],original['nodes'])]
 a=next(r for r in cur if r['name']=='knowledge');b=next(r for r in cur if r['name']=='reverse-middle')
 summary.append({'width':width,'maxNodeGeometryDifferenceFromApprovedMotion':max(comparison),'maxReverseNodeDelta':max(math.hypot(n['rect']['x']-m['rect']['x'],n['rect']['y']-m['rect']['y'])for n,m in zip(a['nodes'],b['nodes'])),'overflow':[r['name']for r in cur if r['overflow']],'errors':[r['errors']for r in rows if r.get('width')==width and r.get('errors')]})
(p/'motion-summary.json').write_text(json.dumps(summary,indent=2))
protected=json.loads((p/'protected-before.json').read_text());(p/'preservation.json').write_text(json.dumps({'checked':len(protected),'changed':[f for f,h in protected.items()if hashlib.sha256(Path(f).read_bytes()).hexdigest()!=h]},indent=2))
files=[*Path('src/components/suite-concept').glob('*'),Path('tests/concept.spec.ts')];(p/'source-manifest.json').write_text(json.dumps({str(f):hashlib.sha256(f.read_bytes()).hexdigest()for f in files},indent=2));print(summary)
