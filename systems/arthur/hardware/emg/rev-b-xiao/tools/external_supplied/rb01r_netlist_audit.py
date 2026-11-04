#!/usr/bin/env python3
"""Independent, read-only RB-01R electrical invariants for KiCad XML netlists.

No schematic generator state is consulted. Expects `kicad-cli sch export netlist
--format kicadxml -o revb.net ARTHUR_EMG_RevB.kicad_sch`.

This is a focused checker, not a complete datasheet verification, ERC, circuit
simulation, electrical safety qualification, or proof of PCB/manufacturability.
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path
from xml.etree import ElementTree as ET

class Netlist:
    def __init__(self, xml):
        root = ET.fromstring(xml)
        self.components = {}
        for comp in root.findall('./components/comp'):
            ref=comp.get('ref')
            fields={f.get('name',''): (f.text or '') for f in comp.findall('./fields/field')}
            props={p.get('name',''):p.get('value','') for p in comp.findall('./property')}
            self.components[ref]={'value':comp.findtext('value',''),'footprint':comp.findtext('footprint',''), 'fields':fields,'properties':props, 'dnp':comp.get('dnp') or comp.findtext('dnp') or props.get('dnp','')}
        self.pins={}
        self.nets={}
        for net in root.findall('./nets/net'):
            name=net.get('name','')
            entries=[]
            for node in net.findall('node'):
                key=(node.get('ref'), node.get('pin'))
                if key in self.pins: raise ValueError('Pin in two nets: '+str(key))
                self.pins[key]=name;entries.append(key)
            self.nets[name]=entries
    def n(self,ref,pin):return self.pins.get((ref,str(pin)))
    def val(self,ref):return self.components.get(ref,{}).get('value','').lower().replace(' ','')
    def same(self,*rp):
        nets=[self.n(r,p) for r,p in rp]
        return bool(nets) and all(x is not None and x==nets[0] for x in nets)
    def absent(self,ref):return ref not in self.components
    def nc(self,ref,pin):
        name=self.n(ref,pin)
        return name is not None and name.startswith('unconnected-') and len(self.nets.get(name,[]))==1
    def net(self,ref,pin):return self.n(ref,pin)

# Invariants are derived from reviewed RB-00.6/RB-01 documents, not the RB-01 generator.
# They deliberately include structural checks able to detect wrong-side clamps and switched rail ties.
def audit(n):
    checks={}
    def c(name,condition,reason=''):
        checks[name]={'ok':bool(condition),'detail':reason if not condition else ''}
    def v(ref,value):
        got=n.val(ref)
        want=value.lower().replace(' ','')
        return got==want or got.replace('1.0k','1k')==want.replace('1.0k','1k')
    def b(ref,a,b):return n.same((ref,a), (ref,b))
    def refpresent(ref):return ref in n.components

    c('A01_patient_pin1_nc',n.nc('J5001','1'))
    c('A02_RLD_100k',v('R5002','100k') and n.same(('J5001','2'),('R5002','2')) and n.same(('R5002','1'),('U503','1')))
    c('A03_patient_mount_nc',n.nc('J5001','MP'))
    c('V01_VCM_div',v('R5003','100k') and v('R5004','100k') and n.same(('R5003','2'),('R5004','1'),('R5005','1')) and v('R5005','10k') and n.same(('R5005','2'),('U503','3')))
    c('V02_VCM_buffer',n.same(('U503','1'),('U503','2')))
    c('V03_unused_followers',all(n.same(('U503',a),('U503',o)) for a,o in [('6','7'),('9','8'),('13','14')]))
    for channel in range(1,5):
        q=channel*100
        for side,suffix,ain in [('P',1,[3,6,7,10][channel-1]),('N',2,[4,5,8,9][channel-1])]:
            r_in=f'R{q+suffix}'; r_ain=f'R{q+6+suffix}'; d_e=f'D{q+suffix}'; d_a=f'D{q+2+suffix}'
            ch=f'C{channel}{side}'
            c(f'{ch}_electrode_series', v(r_in,'10k') and n.same((f'J{q+1}',str(suffix)),(r_in,'1')))
            c(f'{ch}_input_clamp',v(r_in,'10k') and n.same((r_in,'2'),(d_e,'3')) and n.same((d_e,'1'),('U6001','2')) and n.same((d_e,'2'),('U6001','1')))
            c(f'{ch}_adc_clamp',v(r_ain,'1k') and n.same((r_ain,'2'),(d_a,'3'),('U6001',str(ain))) and n.same((d_a,'1'),('U6001','2')) and n.nc(d_a,'2'))
            c(f'{ch}_ac_bias_ground',v(f'R{q+2+suffix}','100k') and n.same((f'R{q+2+suffix}','2'),('U6001','2')))
        c(f'CH{channel}_differential_cap',v(f'C{q+5}','10nF') and n.same((f'C{q+5}','1'),('U6001',str([3,6,7,10][channel-1]))) and n.same((f'C{q+5}','2'),('U6001',str([4,5,8,9][channel-1]))))
    c('P01_AVDD',n.same(('U6001','1'),('U4002','5')))
    c('P02_DVDD',n.same(('U6001','20'),('FB1','2'),('X1','1'),('X1','4')))
    c('P03_CAP',v('C6009','220nF') and n.same(('C6009','1'),('U6001','18')) and n.same(('C6009','2'),('U6001','19')))
    c('P04_common_GND',n.same(('U6001','2'),('U6001','19'),('U1','13'),('J1','2'),('U4002','2')))
    c('P05_filtered_analog_supply',v('R4001','4.7') and n.same(('J1','1'),('R4001','1'),('U1','23')) and n.same(('R4001','2'),('U4002','1'),('C4007','1')))
    c('P06_22uF_single',v('C4007','22uF') and n.same(('C4007','2'),('J1','2')))
    c('P07_filtered_digital_supply',n.same(('U1','12'),('FB1','1')) and n.same(('FB1','2'),('C7101','1'),('C7102','1')))
    c('CLK01_oscillator_to_ADC',v('R6001','33') and n.same(('X1','3'),('R6001','1')) and n.same(('R6001','2'),('U6001','17')))
    c('SPI01_sclk',v('R7101','33') and n.same(('U1','9'),('R7101','1')) and n.same(('R7101','2'),('U6001','14')))
    c('SPI02_mosi',v('R7102','33') and n.same(('U1','11'),('R7102','1')) and n.same(('R7102','2'),('U6001','16')))
    c('SPI03_miso',v('R6002','33') and n.same(('U6001','15'),('R6002','1')) and n.same(('R6002','2'),('U1','10')))
    c('SPI04_drdy',v('R6003','100') and n.same(('U6001','13'),('R6003','1')) and n.same(('R6003','2'),('U1','2')))
    c('SPI05_cs',n.same(('U1','8'),('U6001','12'),('R7103','2')) and v('R7103','100k'))
    c('SPI06_reset',n.same(('U1','3'),('U6001','11'),('R7104','2')) and v('R7104','10k'))
    c('USB01_hw_gate',n.same(('U1','14'),('R3009','1'),('R3006','1')) and v('R3009','4.7k') and n.same(('R3006','2'),('Q3001','1')))
    c('USB02_gate_drain',n.same(('Q3001','3'),('U4002','3'),('R3008','1')) and n.same(('Q3001','2'),('U4002','2')))
    c('USB03_default_off',v('R3008','100k') and n.same(('R3008','2'),('U4002','2')))
    c('USB04_D3_request_series',v('R3007','10k') and n.same(('U1','4'),('R3007','1')) and n.same(('R3007','2'),('Q3001','3')))
    c('USB05_D6_sense_only',v('R7105','100k') and v('R7106','150k') and n.same(('U1','7'),('R7105','2'),('R7106','1')) and n.same(('R7105','1'),('U1','14')))
    c('BAT01_BAT_post',n.same(('U1','23'),('J1','1')) and n.same(('U1','13'),('J1','2')))
    c('BAT02_VBAT_sense',v('R7107','1M') and v('R7108','1M') and n.same(('U1','1'),('R7107','2'),('R7108','1')))
    c('DNP01_unused_d4d5',n.nc('U1','5') and n.nc('U1','6'))
    c('DNP02_unused_options',all(n.absent(x) for x in ['R_OPT0','U_ID','R_SDA','R_SCL']))
    c('DNP03_removed_old',all(n.absent(x) for x in ['Q3002','R3005','U7001','U2001','U4001','J3001','J8001']))
    c('XIAO01_required_custom_footprint','XIAO_ESP32S3_HANDSOLDER' in n.components.get('U1',{}).get('footprint',''))
    return checks

def main(argv=None):
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('netlist',type=Path)
    ap.add_argument('--json',action='store_true')
    args=ap.parse_args(argv)
    n=Netlist(args.netlist.read_bytes())
    results=audit(n)
    failures=[k for k,v in results.items() if not v['ok']]
    if args.json: print(json.dumps({'total':len(results),'failures':failures,'checks':results},indent=2))
    else:
        for k,v in results.items(): print(('PASS' if v['ok'] else 'FAIL')+' '+k+((': '+v['detail']) if v['detail'] else ''))
        print(f'{len(results)-len(failures)}/{len(results)} passed; {len(failures)} failed')
    return 1 if failures else 0

if __name__=='__main__':sys.exit(main())
