#!/usr/bin/env python3
"""Build a separate NOT_RELEASED orientation-review candidate; preserve RC1 bytes.
Argument: fresh rb05_package export directory. No upload, approval or commit.
"""
import copy
import csv
import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile

REV=Path(__file__).resolve().parent.parent
ROOT=REV.parents[2]
OLD=REV/'evidence/pre-manufacturing-audit/jlcpcb-closure'
OLDP=OLD/'NOT_RELEASED_PENDING_FACTORY_APPROVAL'
OUT=REV/'evidence/placement-orientation-2026-10-20'
P=OUT/'NOT_RELEASED_PENDING_PREVIEW_VERIFICATION'
PREFIX='ARTHUR_Neuron_RevB_HJ_JLC_RC2_NOT_RELEASED'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def rows(path):
    return list(csv.DictReader(io.StringIO(path.read_text())))


def norm(data):
    return b'\n'.join(line for line in data.splitlines() if not (b'TF.CreationDate,' in line or line.startswith((b'G04 Created by KiCad ',b'; DRILL file KiCad '))))


def main():
    fresh=Path(sys.argv[1]);P.mkdir(parents=True,exist_ok=True)
    old_manifest=json.loads((OLD/'MANUFACTURING_MANIFEST.json').read_text())
    K=REV/'kicad/ARTHUR_EMG_RevB'
    assert all(sha((K/n).read_bytes())==h for n,h in old_manifest['source_files_sha256'].items()), 'Authoritative PCB/schematic/library changed'
    before=rows(next(OLDP.glob('*_CPL.csv')));after=rows(fresh/'ARTHUR_EMG_RevB_CPL.csv')
    assert len(before)==len(after)==126
    byref={r['Designator']:r for r in after};assert len(byref)==126
    changes=[]
    for a in before:
        b=byref[a['Designator']]
        assert all(a[k]==b[k] for k in a if k!='Rotation'), a
        if a['Rotation']!=b['Rotation']:
            assert a['Rotation']=='0' and b['Rotation']=='180', (a,b)
            changes.append(a['Designator'])
    assert set(changes)=={'J101','J201','J301','J401','J5001'}
    assert byref['J1']==next(r for r in before if r['Designator']=='J1')
    for suffix in ('BOM.csv','CPL_raw_KiCad_rotation.csv'):
        original=next(OLDP.glob(f'*_{suffix}'))
        assert original.read_bytes()==(fresh/f'ARTHUR_EMG_RevB_{suffix}').read_bytes(),suffix
        shutil.copy2(original,P/f'{PREFIX}_{suffix}')
    oldzip=next(OLDP.glob('*_Gerbers.zip'))
    with zipfile.ZipFile(oldzip) as a, zipfile.ZipFile(fresh/'ARTHUR_EMG_RevB_Gerbers.zip') as b:
        assert a.testzip() is b.testzip() is None
        assert set(a.namelist())==set(b.namelist()) and len(a.namelist())==11
        assert all(norm(a.read(n))==norm(b.read(n)) for n in a.namelist())
    # Fabrication geometry did not change; reuse the original ZIP bytes.
    shutil.copy2(oldzip,P/f'{PREFIX}_Gerbers.zip')
    shutil.copy2(fresh/'ARTHUR_EMG_RevB_CPL.csv',P/f'{PREFIX}_CPL.csv')
    for name in ('COMPONENT_REVIEW_REQUEST.csv','MANUAL_XIAO_ASSEMBLY.md'):
        shutil.copy2(OLDP/name,P/name)
    shutil.copy2(OUT/'polarized-orientation-review.csv',P/'placement-review.csv')
    (P/'README.md').write_text('''# RC2 orientation-review candidate — NOT RELEASED

BLOCKED pending assembly-session 2D/3D and polarized-part verification. No production, payment, assembly approval or human-contact approval.

Five north-edge C295747 headers use CPL 180 degrees instead of RC1 0 degrees. J1 stays 270 degrees as requested, but public exact-part pad geometry suggests 90 degrees: HOLD until independently resolved in the actual assembly preview. All other 121 rows are unchanged.

Use the corrected RC2 CPL only as a preview test. Raw KiCad CPL is reference-only. BOM, Gerber/drill and manual assembly inputs are reused unchanged from RC1; no electronic or fabrication changes. Do not approve the entire candidate while J1 or any other preview check is unresolved. The outer REPORT.md and MANUFACTURING_MANIFEST.json define provenance and remaining gates.
''')
    (P/'POLARITY_ORIENTATION_REVIEW.md').write_text('''# RC2 polarity/orientation review — NOT RELEASED

The companion placement-review.csv lists all 29 oriented/polarized components, PCB rotations, before/after CPL angles, exact LCSC part, actual PCB pad-1 coordinate/net and independent public-2D best fit. All assembly-session 3D preview statuses remain UNVERIFIED.

Five north-edge JSTs: CPL 0 → 180 degrees. Required mouths north, signal tails south at board Y=8.00 mm, pin 1 east/pin 2 west, retention tabs north at Y=2.25 mm. J5001 pin 1 is NC; pin 2 is RLD_SAFE. J101/J201/J301/J401 pin 1 is ELEC_P; pin 2 ELEC_N.

J1 remains CPL 270 degrees; public exact-part geometry suggests 90 degrees. Do not approve J1 until its mouth faces east, signal pin 1 is at (41.55,39.30) VBAT, pin 2 at (41.55,37.30) GND, retention tabs east. Check harness polarity separately.

Retained rotations for all 16 BAV199 dual diodes, Q3001 2N7002, U501/U502/U503 TLV9064, U4002 TPS7A2030P, U6001 ADS131M04 and X1 oscillator agree in numbered-pad direction with public exact-part JLC footprints. This is not proof of the factory assembly model or tape/reel zero. A preview red dot is an orientation marker, not a guaranteed pin-1 indicator.

Match physical package marking and every numbered terminal to the PCB land and net. BAV199 is a dual series diode; do not use a single cathode-stripe rule. Inspect SOT23 gate/source/drain and TI pin-1/body marks, oscillator OE/GND/OUT/VDD. U1 is manual/DNP and excluded. No substitutions authorized.
''')
    alternate=OUT/'ALTERNATE_J1_TEST_ONLY'
    alternate.mkdir(exist_ok=True)
    alternate_path=alternate/'ARTHUR_Neuron_RevB_HJ_JLC_RC2_J1_90_TEST_ONLY_NOT_RELEASED_CPL.csv'
    alternate_rows=copy.deepcopy(after)
    next(row for row in alternate_rows if row['Designator']=='J1')['Rotation']='90'
    with alternate_path.open('w',newline='') as handle:
        writer=csv.DictWriter(handle,fieldnames=list(after[0]));writer.writeheader();writer.writerows(alternate_rows)
    remarks=(OLDP/'MANUFACTURING_REMARKS.txt').read_text()
    (P/'MANUFACTURING_REMARKS.txt').write_text('RC2 ORIENTATION REVIEW ONLY — NOT RELEASED; HOLD ALL ASSEMBLY APPROVAL.\nFive north JST CPL rows changed 0 to 180. J1 unchanged 270 but independently suspect (2D library suggests 90); preview resolution mandatory.\nPrior RC1 manufacturing requirements below remain applicable; references to RC1 identify the unchanged source design, not approval of its CPL.\n\n'+remarks)
    verification=dict(source_files_unchanged=27,CPL_rows=126,only_changed_CPL_references=sorted(changes),J1_unchanged=True,BOM_and_raw_CPL_byte_identical=True,Gerbers_geometry_identical=True,original_Gerber_zip_reused=True,assembly_preview_verified=False)
    (OUT/'BUILD_VERIFICATION.json').write_text(json.dumps(verification,indent=2)+'\n')
    manifest=copy.deepcopy(old_manifest)
    manifest.update(status='NOT RELEASED — BLOCKED PENDING PREVIEW VERIFICATION',candidate_revision='HJ-JLC-RC2-ORIENTATION-2026-10-20',generated_local_date='2026-10-20 Europe/Sofia',branch=subprocess.check_output(['git','branch','--show-current'],cwd=ROOT,text=True).strip(),git_HEAD=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),working_tree='Uncommitted exporter correction and RC2 orientation evidence; PCB/schematic/library unchanged',review_readiness='BLOCKED: five-header assembly preview unverified; J1 orientation unresolved',assembly_preview_verified=False,public_library_evidence='sources/JLC_C*_footprint.svg; independent numbered-pad analysis, not factory 3D preview',upstream_manifest_sha256=sha((OLD/'MANUFACTURING_MANIFEST.json').read_bytes()),J1_disposition='PRESERVED 270; public 2D suggests 90; HOLD',changed_CPL_refs=sorted(changes))
    manifest.pop('generated_UTC',None)
    manifest['factory_review_files']=[dict(path=str(p.relative_to(OUT)),sha256=sha(p.read_bytes()),bytes=p.stat().st_size,role='preview_only_NOT_RELEASED') for p in sorted(P.iterdir()) if p.is_file()]
    manifest['alternate_preview_files']=[dict(path=str(alternate_path.relative_to(OUT)),sha256=sha(alternate_path.read_bytes()),role='J1_90_TEST_ONLY; mutually exclusive with main CPL; not approved')]
    manifest['closure_documents_sha256']={}
    manifest['verification_files_sha256']={str(p.relative_to(OUT)):sha(p.read_bytes()) for p in sorted(OUT.glob('*.json')) if p.name!='MANUFACTURING_MANIFEST.json'}
    manifest['orientation_tools_sha256']={str(p.relative_to(REV)):sha(p.read_bytes()) for p in [REV/'tools'/n for n in ('rb05_package.py','jlc_rotations.py','test_jlc_rotations.py','audit_factory_orientation.py','build_orientation_candidate.py','draw_jst_orientation.py')]}
    manifest['public_library_sources_sha256']={str(p.relative_to(OUT)):sha(p.read_bytes()) for p in sorted((OUT/'sources').iterdir())}
    (OUT/'MANUFACTURING_MANIFEST.json').write_text(json.dumps(manifest,indent=2)+'\n')
    included=[*sorted(P.iterdir()),alternate_path,OUT/'MANUFACTURING_MANIFEST.json']
    for name in ('REPORT.md','polarized-pad-analysis.json','polarized-orientation-review.csv','regression-before.txt','regression-after.txt'):
        if (OUT/name).is_file(): included.append(OUT/name)
    sums=''.join(f'{sha(p.read_bytes())}  {p.relative_to(OUT)}\n' for p in included)
    (OUT/'SHA256SUMS.txt').write_text(sums)
    bundle=OUT/'HJ_JLC_RC2_ORIENTATION_REVIEW_NOT_RELEASED.zip'
    with zipfile.ZipFile(bundle,'w',zipfile.ZIP_DEFLATED) as z:
        for p in [*included,OUT/'SHA256SUMS.txt']: z.write(p,str(p.relative_to(OUT)))
    (OUT/'REVIEW_BUNDLE_SHA256.txt').write_text(f'{sha(bundle.read_bytes())}  {bundle.name}\n')
    print(json.dumps(dict(source_files_unchanged=27,CPL_rows=126,only_changed_CPL_references=sorted(changes),J1_unchanged=True,BOM_and_raw_CPL_byte_identical=True,Gerbers_geometry_identical=True,original_Gerber_zip_reused=True,old_candidate_preserved=True,assembly_preview_verified=False),indent=2))


if __name__=='__main__':main()
