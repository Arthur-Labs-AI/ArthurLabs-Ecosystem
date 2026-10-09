import pathlib,hashlib,shutil,json
D=pathlib.Path(__file__).resolve().parent
INPUT='ARTHUR_EMG_RevA_Cost_Phase3B6_LocalGNDClean';BASE='ARTHUR_EMG_RevA_Cost_Phase3A_ThreeNetClean';COPY='ARTHUR_EMG_RevA_Cost_Phase3B_VerificationCandidate'
def sha(n):return hashlib.sha256((D/n).read_bytes()).hexdigest()
assert sha(INPUT+'.kicad_pcb')=='d7a585e8ae46299215d26c0aa58ea0ca5829d46ce72a45d279290263e94a0005'
assert sha(BASE+'.kicad_pcb')==sha('ARTHUR_EMG_RevA_Cost.kicad_pcb')=='7a7a70d78e1e191e13251e24b882b7eeb3df1153912a4168850515c8ac8201f9'
protected={f.name:sha(f.name) for f in D.iterdir() if f.is_file() and not any(q in f.name for q in ['phase3b_final','phase3b_routing_freeze','PHASE3B_ROUTING_FREEZE','Phase3B_Verification','Phase3B_Final'])}
(D/'phase3b_final_provenance_before.json').write_text(json.dumps({'input':INPUT,'baseline':BASE,'protected_sha256':protected},indent=2)+'\n')
for ext in ['.kicad_pcb','.kicad_pro','.kicad_dru']:
 assert sha(INPUT+ext)==sha(INPUT+ext)
 shutil.copyfile(D/(INPUT+ext),D/(COPY+ext))
print('Verification copy prepared; accepted input and production SHA verified')
