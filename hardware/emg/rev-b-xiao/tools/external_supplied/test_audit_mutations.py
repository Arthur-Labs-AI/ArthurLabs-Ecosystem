#!/usr/bin/env python3
"""Regression test for RB-01R netlist checks with deliberately seeded net faults.

Input must be a real XML netlist exported from the project. Every mutation is a
negative test: it is expected to fail the targeted check. This test does NOT
prove the unmodified netlist is electrically correct by itself.
"""
import copy
import sys
from pathlib import Path
from xml.etree import ElementTree as ET
from rb01r_netlist_audit import Netlist, audit

# The exact errors have documented historical precedents. Network membership
# is modified directly; no generator-authored intent JSON is used.
CASES=[
  ('patient_ground','J5001','1','GND','A01_patient_pin1_nc'),
  ('wrong_diode_side','D103','3','/CH1/ACN_P','C1P_adc_clamp'),
  ('ADC_AVDD_miswire','U6001','1','DVDD_F','P01_AVDD'),
  ('ADC_DVDD_miswire','U6001','20','AFE_3V0','P02_DVDD'),
  ('ADC_CLOCK_from_MCU','U6001','17','/SCLK','CLK01_oscillator_to_ADC'),
  ('battery_post_wrong','U1','23','/Analog_Power_Interlock/VBAT_AFE','BAT01_BAT_post'),
  ('unsafe_D3_bypass','U1','4','/Analog_Power_Interlock/AFE_EN','USB04_D3_request_series'),
  ('missing_EN_pulldown','R3008','1','unconnected-TEST','USB02_gate_drain'),
  ('PGA_input_wrong_pin','U6001','3','/CH1/ACN_P','C1P_adc_clamp'),
  ('J5001_RLD_short','J5001','2','GND','A02_RLD_100k'),
  ('VBUS_absent','U1','14','unconnected-TEST','USB01_hw_gate'),
]

def main(file):
    source=Path(file).read_bytes()
    native=Netlist(source)
    base=audit(native)
    base_failed={k for k,v in base.items() if not v['ok']}
    if base_failed:
        print('BASELINE FAIL:',', '.join(sorted(base_failed)));return 1
    bad=0
    for title,ref,pin,target,expected in CASES:
        root=ET.fromstring(source)
        for net in root.findall('./nets/net'):
            for node in list(net.findall('node')):
                if node.get('ref')==ref and node.get('pin')==pin:net.remove(node)
        dest=next((net for net in root.findall('./nets/net') if net.get('name')==target),None)
        if dest is None:
            dest=ET.SubElement(root.find('nets'),'net',{'name':target,'code':'9999'})
        ET.SubElement(dest,'node',{'ref':ref,'pin':pin})
        outcome=audit(Netlist(ET.tostring(root)))
        ok=not outcome.get(expected,{}).get('ok',True)
        print(('PASS' if ok else 'FAIL'),title,'->',expected)
        bad+=not ok
    print(f'{len(CASES)-bad}/{len(CASES)} seeded faults detected')
    return 1 if bad else 0

if __name__=='__main__':sys.exit(main(sys.argv[1]))
