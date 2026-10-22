from pathlib import Path
import hashlib,json
before=json.loads(Path('artifacts/sentry-phase-4a/before.json').read_text())
current={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for root in ['src','public','tests'] for p in Path(root).rglob('*') if p.is_file()}
changes={'modified':[p for p in before if current.get(p)!=before[p]],'created':[p for p in current if p not in before]}
Path('artifacts/sentry-phase-4a/changed-files.json').write_text(json.dumps(changes,indent=2))
assert not changes['modified'],changes['modified']
print('Preserved all pre-existing source/public/test files; '+str(len(changes['created']))+' new files.')
