"""RB-02 placement table for the Rev B board (hand-authored; no routing).

Coordinates are written in the *RB-00.6 frame* x' (the XIAO module east edge at x' = 72.78, origin of y at the board
north edge) and shifted by DX into the board frame at build time, so the Zone D numbers stay exactly the frozen
RB-00.6 numbers and only Zone A grows to the west.  y is the board frame (0 = north edge, H = 32 = south edge).

place[ref] = (x', y, rotation_deg, side)   side "F" or "B"
"""
DX = 22.0           # board x = x' + DX  (Zone A extension, justified in REVB_RB02_PLACEMENT_REPORT.md)
BOARD_W = 75.0 + DX
BOARD_H = 32.0
CORNER_R = 1.0

place = {}


def P(ref, x, y, rot=0, side="F"):
    assert ref not in place, ref
    place[ref] = (x, y, rot, side)


# ---------------- XIAO (frozen RB-00.6: module centre, rotated 180, USB end on the south edge)
P("U1", 63.89, 32.0 - 10.5675, 180)

# ---------------- electrode connectors on the south edge (courtyard 9.4 x 8.5, 9.4 pitch, centre y = 32 - 3.75)
CX = {5001: -16.8, 1: -7.4, 2: 2.0, 3: 11.4, 4: 20.8}
P("J5001", CX[5001], 28.25)
for c in (1, 2, 3, 4):
    P(f"J{c}01", CX[c], 28.25)

# ---------------- per-leg input cells (Rs, hi-Z clamp, 100 pF, 10 M) above the connector, amps above the cells
LEG = {}          # (c, side) -> column centre x'
for c in (1, 2, 3, 4):
    LEG[(c, "P")] = CX[c] - 2.35
    LEG[(c, "N")] = CX[c] + 2.35
for c in (1, 2, 3, 4):
    b = c * 100
    for side, o in (("P", 0), ("N", 1)):
        xc = LEG[(c, side)]
        P(f"R{b+1+o}", xc, 21.9, 90)            # 10 k electrode series
        P(f"D{b+1+o}", xc, 18.0, 0)             # BAV199 hi-Z clamp (pin 3 = hi-Z node)
        P(f"C{b+3+o}", xc - 1.2, 14.0, 90)      # 100 pF
        P(f"R{b+5+o}", xc + 1.2, 14.0, 90)      # 10 M to VCM
        # north band: AC coupling cap, 100 k DC return, 1 k series
        P(f"C{b+1+o}", xc - 1.55, 3.2, 90)
        P(f"R{b+3+o}", xc, 3.2, 90)
        P(f"R{b+7+o}", xc + 1.55, 3.2, 90)

P("U501", (CX[1] + CX[2]) / 2, 9.4, 0)
P("U502", (CX[3] + CX[4]) / 2, 9.4, 0)
P("C501", (CX[1] + CX[2]) / 2 - 5.2, 9.4, 90)
P("C502", (CX[3] + CX[4]) / 2 - 5.2, 9.4, 90)

# ---------------- VCM / RLD block (west end, next to J5001)
P("U503", CX[5001] + 3.0, 9.4, 0)
P("C503", CX[5001] + 3.0 - 5.2, 9.4, 90)
P("R5003", CX[5001] - 3.6, 3.2, 90)
P("R5004", CX[5001] - 2.0, 3.2, 90)
P("R5005", CX[5001] - 0.4, 3.2, 90)
P("C5001", CX[5001] + 1.2, 3.2, 90)
P("C5002", CX[5001] + 2.8, 3.2, 90)
P("R5002", CX[5001], 21.7, 90)          # 0805 RLD series, at the J5001 pin 2 side

# ---------------- ADC (Zone B)
ADC = (42.0, 19.0)
P("U6001", ADC[0], ADC[1], 0)
# ADC-side input network: the 1 nF caps sit against the AIN pins (one horizontal column), the 8 BAV199 clamps in two
# columns further west (rows 3.6 mm apart), the 10 nF differential caps above/below the clamp block
legs = [(1, "P", 3), (1, "N", 4), (2, "N", 5), (2, "P", 6), (3, "P", 7), (3, "N", 8), (4, "N", 9), (4, "P", 10)]
ROWS = [13.2, 16.8, 20.4, 24.0]
for i, (c, side, pin) in enumerate(legs):
    b = c * 100
    o = 0 if side == "P" else 1
    col_x = 32.8 if i % 2 == 0 else 28.9
    P(f"D{b+3+o}", col_x, ROWS[i // 2], 0)
    P(f"C{b+6+o}", 36.3, 19.65 + (i - 3.5) * 1.5, 0)
P("C105", 30.8, 9.8, 0)
P("C205", 34.6, 9.8, 0)
P("C305", 30.8, 28.2, 0)
P("C405", 34.6, 28.2, 0)

# ---------------- ADC supply / clock / SPI (Zone B east, Zone C): two columns east of the ADC, x' <= 52.2
P("C6007", 39.6, 13.3, 90)      # AVDD 1 uF at pin 1
P("C6008", 44.4, 13.9, 90)      # DVDD 1 uF at pin 20
P("X1", 47.9, 14.1, 180)        # oscillator <= 5 mm from CLKIN (pin 17)
P("C6010", 47.9, 11.7, 0)       # X1 100 nF
P("C6009", 47.6, 16.45, 0)      # CAP 220 nF at pin 18
P("R6001", 47.6, 18.0, 0)       # 33 ohm CLKIN source series
P("R6002", 47.6, 19.55, 0)      # DOUT 33 ohm at the ADC end
P("R6003", 47.6, 21.1, 0)       # DRDY 100 ohm
P("R7103", 47.6, 22.65, 0)      # CS pull-up
P("R7104", 47.6, 24.2, 0)       # SYNC pull-up
P("R7101", 50.7, 16.55, 0)       # SCLK 33 ohm at the XIAO end (D8 y = 16.40)
P("R7102", 50.7, 21.5, 0)       # MOSI 33 ohm at the XIAO end (D10)
P("FB1", 50.7, 24.0, 0)         # DVDD ferrite at the 3V3 pad (y = 24.02)
P("C7101", 50.7, 25.55, 0)
P("C7102", 50.7, 27.1, 0)
P("R3009", 50.7, 29.1, 0)       # 4.7 k XIAO 5V load, at pin 14
P("R7105", 47.6, 28.4, 0)
P("R7106", 47.6, 29.95, 0)

# ---------------- north strip: power / inhibit / battery
P("U4002", 46.0, 4.6, 0)
P("C4005", 42.5, 4.6, 90)
P("C4006", 49.6, 4.6, 90)
P("R3007", 41.8, 8.6, 0)
P("R3008", 45.0, 8.6, 0)
P("R3004", 48.2, 8.6, 0)
P("R3006", 51.4, 8.6, 0)
P("Q3001", 52.4, 4.8, 0)
P("R4001", 57.6, 2.8, 0)
P("C4007", 57.6, 5.6, 0)
P("J1", 66.5, 5.2, 180)
P("R7107", 72.9, 2.6, 90)
P("R7108", 72.9, 5.7, 90)
P("C7103", 72.9, 8.8, 90)

# ---------------- test points (bare B.Cu pads, not assembled)
P("TP1", 60.5, 9.0, 0, "B")
P("TP2", 52.0, 1.5, 0, "B")
P("TP3", 44.0, 25.0, 0, "B")
P("TP4", CX[5001] - 3.7, 12.0, 0, "B")
P("TP5", CX[5001] - 1.5, 17.0, 0, "B")
P("TP6", 38.0, 8.6, 0, "B")
P("TP7", 36.0, 4.0, 0, "B")
P("TP8", 32.0, 4.0, 0, "B")
