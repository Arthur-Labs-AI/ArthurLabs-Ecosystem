import re, uuid
NETFILE = r'C:\Users\nikol\AppData\Local\Temp\dsh-217e9p\tp3.net'
OUTFILE = r'D:\A.R.T.H.U.R\hardware\emg\rev-a\kicad\ARTHUR_EMG_RevA\ARTHUR_EMG_RevA.kicad_pcb'
lines = open(NETFILE, encoding='utf-8').read().splitlines()
# parse nets: (net (code N) (name "X") ... nodes (ref ... pin ...))
nets = {}  # code -> name
cur_code = None
comp_pins = {}  # ref -> {pin: netname}
cur_name = None
for i, l in enumerate(lines):
    m = re.match(r'\s*\(code "?(\d+)"?\)', l)
    if m:
        cur_code = m.group(1)
        continue
    m = re.match(r'\s*\(name (.+)\)', l)
    if m:
        cur_name = m.group(1).strip('"')
        if cur_code is not None:
            nets[cur_code] = cur_name
        continue
    m = re.match(r'\s*\(ref ("[^"]+"|\S+)', l)
    if m and cur_name is not None:
        ref = m.group(1).strip('"')
        # next lines: pin
        pin = None
        for j in range(i + 1, min(i + 4, len(lines))):
            pm = re.match(r'\s*\(pin "?([^")]+)"?\)', lines[j])
            if pm:
                pin = pm.group(1)
                break
        if pin is not None:
            comp_pins.setdefault(ref, {})[pin] = cur_name
print('nets:', len(nets), 'comps:', len(comp_pins))
# net name -> code map (first code wins)
name2code = {}
for code, name in nets.items():
    if name not in name2code:
        name2code[name] = code
open(r'C:\Users\nikol\AppData\Local\Temp\dsh-217e9p\pcbdata.json', 'w').write(__import__('json').dumps({'nets': nets, 'name2code': name2code, 'comp_pins': comp_pins}))
print('saved')
