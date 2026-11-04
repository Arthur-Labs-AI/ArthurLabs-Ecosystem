# RB-02 — Mechanical Risks and BAT+ Post Trade-offs

Date: 2026-10-10. Evidence: `rev-b-xiao/evidence/rb02/post_tolerance_stack.txt` (`rb02_post_tolerance_stack.py`,
worst case + 100 k-sample uniform Monte-Carlo).

## 1. BAT+ post tolerance stack

Inputs: AWG24 post 0.50–0.56 mm; JLC finished-hole tolerance +0.13/−0.08; hole position ±0.075; post offset on the
module pad ±0.253; module placement ±0.2 after the post locates it; ring/mask as in each option. JLC capability numbers
were read from the fabricator's published page (2026-10-10). Offsets and placement errors are assumptions, swept.

| Option | Change | Hole (finished) | Cone margin worst | Annulus worst | Mask opening − hole worst | P(annulus < 0.20) | P(ring overlaps GND0 pad) | Cone → GND0 worst |
|---|---|---|---|---|---|---|---|---|
| **A** frozen | none (cone ≤ 1.1) | 1.32–1.53 | 0.11 | 0.185 | −0.04 | 14.5 % | 4.6 % (mask-covered) | 0.594 |
| **B** | cone target ≤ 1.0 (process only) | 1.32–1.53 | 0.16 | 0.185 | −0.04 | 14.3 % | 4.7 % | 0.644 |
| **E** | B + mask opening 1.55 | 1.32–1.53 | 0.16 | 0.185 | +0.01 | 14.6 % | 4.7 % | 0.646 |
| **C** | B + ring 2.00, mask 1.55 | 1.32–1.53 | 0.16 | 0.235 | +0.01 | 0 % | 13.7 % | 0.645 |
| **D** | drill 1.50, ring 2.10, mask 1.60 | 1.42–1.63 | 0.16 | 0.235 | −0.015 | 0 % | 27.4 % | 0.594 |

Findings common to all options: P(cone does not fit) = 0; castellation overlap ≥ 1.035 mm (vs 1.0 mm requirement);
post play 0.38–0.515 mm (post never jams in the hole).

Reading:

* **A is manufacturable.** The only weak figure is the annular ring: 0.185 worst case is above the fabricator's 0.15
  absolute minimum but below its 0.20 recommendation, with ~14 % probability of falling under 0.20 on a given hole.
  It does not fall under 0.15 within the stated tolerances.
* **B** costs nothing in the design and buys +0.05 mm of cone margin. Recommended.
* **E** closes the mask-vs-hole worst-case (mask edge falls inside a maximum-size hole in A/B), at the cost of a
  thinner mask annulus (0.175, above the 0.10 mask bridge). Optional.
* **C/D** fix the annulus but increase the chance the larger ring plan-overlaps the neighbouring GND0 host pad
  (13.7 % / 27.4 %). Overlap is mask-covered, but it is a worse trade for a hand-soldered power node.

**Recommendation:** keep A as the frozen geometry, adopt B as a process requirement (cone ≤ 1.0 mm, h ≤ 0.4 mm),
treat E as an optional mask edit the owner can approve. **No drill change.** Nothing from C/D/E was implemented in the
PCB — the board still carries the frozen A values. Owner decision needed on B/E before manufacturing release.

## 2. Remaining physical uncertainties

| # | Item | Impact | How to close |
|---|---|---|---|
| 1 | Module PCB thickness | cone/hole fit, post height | caliper, one module |
| 2 | Module outline / castellation pitch | pad overlap margin | caliper |
| 3 | BAT+ pad position vs CAD | post alignment | caliper / visual |
| 4 | USB shell ovals exposed on production modules | keep-out relevance | visual |
| 5 | B2B connectors populated and height | underside clearance (module sits on host; connectors are over host keep-out) | visual/caliper |
| 6 | U.FL plug/cable height and bend radius | antenna corridor, enclosure | measure with real antenna |
| 7 | Hand-solder cone shape in practice | A/B margin | first-article inspection |
| 8 | PCB thickness (host) | stack-up / impedance not required, mechanical fit | fabricator quote |

## 3. Underside keep-outs (host board below the module)

Pads 15–22 and 25 (module bottom contacts): no tracks/vias; GND0 pad: no vias; four USB shell GND ovals S1–S4: no
tracks/vias, pour allowed; via field around the TP box: no vias. All present as board-level rule areas, proven by seeded
vias. Test points and bare B.Cu pads on the back are outside these areas.

## 4. Enclosure and assembly assumptions

* USB-C receptacle overhangs the south edge by 1.508 mm; plug overmold up to 12.4 mm wide must clear the enclosure
  opening. No components within the USB corridor.
* U.FL cable corridor east of the connector, 4 mm wide, kept free; antenna routing is an enclosure matter.
* No components within 1.5 mm west of the castellation toes (soldering iron access); 1.5–4 mm band ≤ 1.2 mm tall.
* Components near long edges (35 parts) require JLC process rails or a panel with rails (adds width, mechanical only).
* The module is DNP and hand soldered; the host is single-side SMT.
* Height of J1 (battery JST) and the electrode connectors vs enclosure not modelled beyond the placement height table.

## 5. Risk register

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| Thin BAT+ annular ring on one hole | medium (14 % < 0.20) | low (≥ 0.185 worst) | accept A; or C if the owner prefers copper to overlap risk |
| Cone does not enter hole | ~0 | medium | B process control |
| Module not seated flat | low | medium | measure thickness; first-article |
| Process rails add manufacturing cost | high | low | accept or reposition parts |
| Module drawing differs from real module | low | high | caliper checks before release |
