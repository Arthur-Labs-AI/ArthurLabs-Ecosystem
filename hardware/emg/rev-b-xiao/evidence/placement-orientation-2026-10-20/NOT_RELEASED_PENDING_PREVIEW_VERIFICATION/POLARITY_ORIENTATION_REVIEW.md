# RC2 polarity/orientation review — NOT RELEASED

The companion placement-review.csv lists all 29 oriented/polarized components, PCB rotations, before/after CPL angles, exact LCSC part, actual PCB pad-1 coordinate/net and independent public-2D best fit. All assembly-session 3D preview statuses remain UNVERIFIED.

Five north-edge JSTs: CPL 0 → 180 degrees. Required mouths north, signal tails south at board Y=8.00 mm, pin 1 east/pin 2 west, retention tabs north at Y=2.25 mm. J5001 pin 1 is NC; pin 2 is RLD_SAFE. J101/J201/J301/J401 pin 1 is ELEC_P; pin 2 ELEC_N.

J1 remains CPL 270 degrees; public exact-part geometry suggests 90 degrees. Do not approve J1 until its mouth faces east, signal pin 1 is at (41.55,39.30) VBAT, pin 2 at (41.55,37.30) GND, retention tabs east. Check harness polarity separately.

Retained rotations for all 16 BAV199 dual diodes, Q3001 2N7002, U501/U502/U503 TLV9064, U4002 TPS7A2030P, U6001 ADS131M04 and X1 oscillator agree in numbered-pad direction with public exact-part JLC footprints. This is not proof of the factory assembly model or tape/reel zero. A preview red dot is an orientation marker, not a guaranteed pin-1 indicator.

Match physical package marking and every numbered terminal to the PCB land and net. BAV199 is a dual series diode; do not use a single cathode-stripe rule. Inspect SOT23 gate/source/drain and TI pin-1/body marks, oscillator OE/GND/OUT/VDD. U1 is manual/DNP and excluded. No substitutions authorized.
