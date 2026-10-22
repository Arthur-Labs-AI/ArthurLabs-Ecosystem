from PIL import Image,ImageDraw
from pathlib import Path
import json,math
p=Path('artifacts/suite-concept')
for width in [390,768,1440,1920]:
 names=['begin','knowledge','plan','end']
 cellw=390 if width==390 else 480;cellh=844 if width==390 else 350
 s=Image.new('RGB',(cellw*4,cellh+35),'#121512');d=ImageDraw.Draw(s)
 for i,name in enumerate(names):
  im=Image.open(p/f'concept-{width}-{name}.png').convert('RGB');im.thumbnail((cellw,cellh));d.text((i*cellw+12,10),name.upper(),fill='white');s.paste(im,(i*cellw,35))
 s.save(p/f'concept-{width}-storyboard.jpg',quality=94)
# Closely spaced transformation views plus the settled end.
s=Image.new('RGB',(1440,3*330),'#111411');d=ImageDraw.Draw(s)
for i,name in enumerate(['begin','unfold-1','unfold-2','knowledge','align-1','plan','transform-1','transform-2','end']):
 im=Image.open(p/f'concept-1440-{name}.png').convert('RGB');im.thumbnail((480,300));x=i%3*480;y=i//3*330;d.text((x+12,y+8),name,fill='white');s.paste(im,(x,y+28))
s.save(p/'transformation-sequence.jpg',quality=94)
rows=json.loads((p/'measurements.json').read_text());out=[]
for width in [390,768,1440,1920]:
 a=next(r for r in rows if r.get('width')==width and r.get('name')=='knowledge');b=next(r for r in rows if r.get('width')==width and r.get('name')=='reverse-middle');z=next(r for r in rows if r.get('width')==width and r.get('name')=='end');out.append({'width':width,'reversePositionMaxDelta':max(math.hypot(n['rect']['x']-m['rect']['x'],n['rect']['y']-m['rect']['y'])for n,m in zip(a['nodes'],b['nodes'])),'storageNodeDisplacement':math.hypot(a['nodes'][1]['rect']['x']-z['nodes'][1]['rect']['x'],a['nodes'][1]['rect']['y']-z['nodes'][1]['rect']['y']),'cameraChanges':a['camera']!=z['camera'],'pathChanges':a['paths']!=z['paths'],'overflow':[r['name']for r in rows if r.get('width')==width and r.get('overflow')],'errors':[r['errors']for r in rows if r.get('width')==width and 'errors'in r]})
(p/'motion-summary.json').write_text(json.dumps(out,indent=2));print(json.dumps(out,indent=2))
