from pathlib import Path
import hashlib,json,sys
paths=[p for root in ['src','public','tests'] for p in Path(root).rglob('*') if p.is_file()]
data={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
if '--check' in sys.argv:
 old=json.loads(Path('artifacts/phase-3b/before.json').read_text()); print(json.dumps({'modified':[p for p in old if data.get(p)!=old[p]],'created':[p for p in data if p not in old]},indent=2))
else: Path('artifacts/phase-3b/before.json').write_text(json.dumps(data,indent=2))
