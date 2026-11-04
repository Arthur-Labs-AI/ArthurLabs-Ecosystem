#!/usr/bin/env python3
"""RB-01R reproducible design calculations (no netlist needed).

Every constant is a datasheet number with its source; nothing is derived from the
schematic generator.  Output is printed as plain text so REVB_RB01R_INDEPENDENT_REVIEW.md
can quote it verbatim:  python3 rb01r_calcs.py
"""
import math

K_B_Q = 8.617333e-5  # V/K


def vt(t_c):
    return K_B_Q * (t_c + 273.15)


def section(t):
    print("\n== " + t + " ==")


# --------------------------------------------------------------------------- ADC limits
# TI ADS131M04 SBAS890D rev D (May 2021): 6.1 absmax, 6.3 recommended, 6.5 electrical, Table 7-1 noise
AVDD_NOM, AVDD_TOL = 3.0, 0.015           # TPS7A2030 DBV 3.0 V +/-1.5 % (TPS7A20 SBVS338H)
AVDD_MIN, AVDD_MAX = AVDD_NOM * (1 - AVDD_TOL), AVDD_NOM * (1 + AVDD_TOL)
VREF = 1.2
ABS_LO, ABS_HI_OVER = -1.6, +0.3           # AGND-1.6 ... AVDD+0.3
REC_LO = -1.3
GAINS = (1, 2, 4, 8, 16, 32, 64, 128)

section("ADS131M04 analog-input limits per gain (single-ended AIN, volts re AGND)")
print("AVDD range from the LDO: %.3f .. %.3f V" % (AVDD_MIN, AVDD_MAX))
print("Absolute maximum: %.1f .. AVDD+%.1f V (%.3f .. %.3f V)" % (ABS_LO, ABS_HI_OVER, ABS_LO, AVDD_MAX + ABS_HI_OVER))
print("gain  FS(diff,+/-)   rec.lower  rec.upper(AVDD min)  rec.upper(AVDD max)  CM window incl. +/-FS/2 per leg")
for g in GAINS:
    up_off = 0.0 if g <= 4 else 1.8
    fs = VREF / g
    print("%4d  +/-%7.2f mV   %.2f     %.3f              %.3f              %s" % (
        g, fs * 1e3, REC_LO, AVDD_MIN - up_off, AVDD_MAX - up_off,
        "0 V +/-%.3f V per leg is inside" % min(-REC_LO, AVDD_MIN - up_off)))

section("Input bias current through the 100k DC returns (R103/R104 ...)")
for g, ib in ((1, 0.6e-6), (8, 0.2e-6)):
    print("gain %d: IB (typ, (IBP+IBN)/2) = %.1f uA -> %.0f mV common-mode shift across 100 kohm (sign not specified)" % (g, ib * 1e6, ib * 1e5 * 1e3))
print("Mismatch of IBP/IBN is NOT specified by SBAS890D; a 50 %% mismatch at gain 8+ would be %.0f mV differential "
      "= %.0f %% of the gain-32 positive full scale (37.5 mV): bench-measure, or use the ADC DC-block filter." % (0.5 * 0.2e-6 * 1e5 * 1e3, 100 * 0.5 * 0.2e-6 * 1e5 / 0.0375))

# --------------------------------------------------------------------------- noise
section("Noise vs gain (SBAS890D Table 7-1, uVrms, fCLKIN 8.192 MHz, typ 25 C) and front-end estimate")
noise = {  # OSR: (kSPS, [g1..g128])
    4096: (1.0, [3.38, 2.99, 2.88, 1.74, 1.17, 0.77, 0.77, 0.77]),
    2048: (2.0, [4.25, 3.91, 3.79, 2.27, 1.52, 1.00, 1.00, 1.00]),
    1024: (4.0, [5.35, 4.68, 4.52, 2.70, 1.82, 1.20, 1.20, 1.20]),
}
print("gain      " + "  ".join("%5d" % g for g in GAINS))
for osr, (ksps, row) in noise.items():
    print("OSR %4d (%.0f kSPS)  " % (osr, ksps) + "  ".join("%5.2f" % x for x in row))
# front end: 2 x 10k series (R101/R102 per channel) + TLV9064 en 16 nV/rtHz @1 kHz (SBOS839N), band 20-450 Hz
k, T = 1.380649e-23, 305.0
rs = 10e3
e_r = math.sqrt(4 * k * T * rs) * 1e9
e_amp = 16.0
e_leg = math.hypot(e_r, e_amp)
e_diff = e_leg * math.sqrt(2)
band = math.sqrt(450 - 20)
print("front end (excluding skin/electrode impedance): R 10k = %.1f nV/rtHz, TLV9064 en 16 nV/rtHz (1 kHz) -> %.1f nV/rtHz diff -> %.2f uVrms in 20-450 Hz"
      % (e_r, e_diff, e_diff * band * 1e-3))
print("=> ADC noise at 1 kSPS: gain 8 = 1.74, 16 = 1.17, 32 = 0.77 uV; gain 64/128 = 0.77 (no further gain). "
      "Gain >= 32 reaches the front-end/ADC noise-matched point; above 32 only costs headroom.")
print("FSR headroom at gain 8/16/32: +/-150 / +/-75 / +/-37.5 mV differential.")

# --------------------------------------------------------------------------- diode
section("BAV199 conduction / leakage bounds (Nexperia BAV199, 1 April 2023, Table 7)")
IR25, IR150 = 5e-9, 80e-9                  # max IR at VR = 75 V
dbl_per_K = (math.log2(IR150 / IR25)) / (150 - 25)
print("IR max: %.0f nA @25 C, %.0f nA @150 C -> doubles every %.1f K (log-linear between the two datasheet maxima)" % (IR25 * 1e9, IR150 * 1e9, 1 / dbl_per_K))
for tc in (25, 45):
    isb = IR25 * 2 ** ((tc - 25) * dbl_per_K)
    print("T = %d C: Is <= IR(75 V) = %.2f nA ; zero-bias resistance >= n*VT/Is = %.1f Mohm (n = 1)" % (tc, isb * 1e9, vt(tc) / isb / 1e6))
print("Correction of RB-00.5: VF(max) at IF is an UPPER bound on the voltage needed for IF, i.e. a LOWER bound on Is "
      "(Is >= IF/exp(VF/nVT)); it cannot bound Is from above. Upper bound used instead: Is <= IR(max).")
print("Datasheet-rigorous worst-case forward current of ONE clamp at |V| below the rail (n >= 1 is the only physical limit):")
Tc = 45
Is45 = IR25 * 2 ** ((Tc - 25) * dbl_per_K)
rsrc = 1e3 + 3.6e3     # R107 + |Z(2.2 uF)| at 20 Hz  (signal-band source impedance seen by the clamp)
print("   |V| mV   I_fwd,max (n=1, 45C)   I_nonlinear = I - G0*V    error at 4.6k source    vs signal amplitude")
for a_mv in (10, 19, 37.5, 75, 150, 300):
    a = a_mv * 1e-3
    i_f = Is45 * (math.exp(a / vt(Tc)) - 1)
    i_lin = Is45 * a / vt(Tc)
    i_nl = i_f - i_lin
    v_err = i_nl * rsrc
    print("   %6.1f   %12.3g A        %12.3g A          %10.3g V          %.1f dB" % (a_mv, i_f, i_nl, v_err, 20 * math.log10(max(v_err, 1e-30) / a)))
print("These are UPPER bounds from datasheet extrema, not predictions. They show the datasheet alone cannot guarantee clamp-free "
      "linearity above ~tens of mV; Fig. 2 (typical) shows conduction only above ~0.6 V. => bench measurement is required (see review S4.3).")

section("Power-down transient at ADC inputs (clamp, shutdown)")
R107_min = 1e3 * 0.99
for vc in (1.50, 1.84, AVDD_MAX + 0.005):
    vf = 1.0                      # VF max @ 10 mA (bounds the VF at <= 3.1 mA, VF is monotonic in IF)
    i = (vc - 0.9) / R107_min     # 0.9 V = VF max @ 1 mA, for an upper estimate of the current
    print("V_C = %.2f V: I_clamp <= %.2f mA ; AIN >= -(VF(10 mA)=%.2f + 0.09 cold) = %.2f V" % (vc, i * 1e3, vf, -(vf + 0.09)))
print("worst AIN = -1.09 V; margin to recommended -1.3 V = 0.21 V; to absolute maximum -1.6 V = 0.51 V.")
print("(RB-00.5 quoted -1.04 V using a log interpolation between the 1 mA and 10 mA VF maxima; the monotonic bound is used here.)")

section("Power-up transient (positive side)")
for c_derate in (0.5, 1.0):
    c = 2.2e-6 * c_derate
    tau = 100e3 * c
    for vstep in (1.84, AVDD_MAX):
        t_rec = tau * math.log(vstep / (AVDD_MIN - 1.8))
        print("C=%.2f uF (%.0f %% of 2.2) tau=%.0f ms, AIN step %.2f V: above the gain>=8 recommended ceiling %.3f V for %.0f ms; "
              "settled (5 tau) after %.2f s" % (c * 1e6, 100 * c_derate, tau * 1e3, vstep, AVDD_MIN - 1.8, t_rec * 1e3, 5 * tau))
print("AIN never exceeds AVDD (follower output <= V+) -> inside absolute maximum AVDD+0.3 V at every instant.")

# --------------------------------------------------------------------------- DVDD_F
section("DVDD_F worst-case current budget")
VMAX = 3.6                                  # ADC DVDD recommended max
items = [
    ("U6001 IDVDD, HR mode, SPI idle (SBAS890D 6.5 max)", 0.5e-3),
    ("U6001 SPI activity allowance (DOUT 20 pF @ 8 MHz = 0.5 mA)", 0.5e-3),
    ("X1 SCTF SX3M Icc max (1-40 MHz, 15 pF)", 10e-3),
    ("R7104 10k SYNC_RESET_N pull-up while driven low @3.6 V", VMAX / 10e3),
    ("R7103 100k CS_N pull-up while driven low @3.6 V", VMAX / 100e3),
]
tot = 0
for n, i in items:
    tot += i
    print("  %-62s %7.3f mA" % (n, i * 1e3))
print("  %-62s %7.3f mA" % ("TOTAL worst case", tot * 1e3))
print("  XIAO 3V3 stated capability 700 mA (Seeed wiki) -> our load = %.1f %% of it; remaining 3V3 budget for ESP32 = %.1f mA" % (100 * tot / 0.7, 700 - tot * 1e3))
fb_dcr = 0.5
print("  FB1 (0603 600R@100MHz, spec >= 200 mA, DCR <= 0.5 ohm): drop %.1f mV, %.1f %% of rated current -> margin x%.0f" % (tot * fb_dcr * 1e3, 100 * tot / 0.2, 0.2 / tot))
print("  DVDD at U6001/X1 = XIAO 3V3 (3.3 V nominal) - %.1f mV; limits: ADC 2.7..3.6 V, X1 1.62..3.63 V -> margin >= 0.3 V on the top side for a 3.3 V +/-3 %% rail" % (tot * fb_dcr * 1e3))
print("  X1 supply ripple from output edges: %.0f mA * 61 ns / 100 nF = %.1f mV" % (10, 10e-3 * 61e-9 / 100e-9 * 1e3))
