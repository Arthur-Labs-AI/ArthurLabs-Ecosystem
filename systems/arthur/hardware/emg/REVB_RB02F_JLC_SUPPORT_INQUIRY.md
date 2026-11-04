# JLCPCB support inquiry — Economic PCBA board-edge clearance (READY TO SEND, NOT SENT)

Status: draft prepared 2026-10-10. Nothing has been sent and no response exists. Verify the contact address on the Help Center
before sending (the page shows a "support" e-mail and an online chat). Send as text; attach the three files listed at the end.

**Subject:** Economic PCBA — is a 97 × 32 mm 4-layer, top-side-only design with parts < 2.5 mm from the edge acceptable?

Hello JLCPCB team,

We plan an Economic PCBA order (2 assembled boards) and would like written clarification of one rule conflict before we finish layout.

**Design:** 97.0 × 32.0 mm single board, 4 copper layers, 1.6 mm, standard JLC 4-layer stack-up, SMT on the TOP side only (126 parts:
0603/0805 passives, SOT-23, TSSOP, JST PH connectors, one 3.2 × 2.5 mm oscillator). No bottom-side assembly, no through-hole parts
for JLCPCB, no castellations or edge plating on the PCB. One footprint (a plug-in module) is DNP and hand-soldered by us. No rails,
tooling holes or fiducials are in our design; we expect JLCPCB to add what it needs.

**The conflict we found in your published documents:**

1. *Terms and Conditions of JLCPCB Assembly Service*, section "Notes on DFM", item 3: the distance between the body of the components
   and the edge of the board must be equal or greater than 2.5 mm
   (https://jlcpcb.com/help/article/Terms-and-Conditions-of-JLCPCB-Assembly-Service).
2. *PCB Assembly FAQs (Part 2)*, item 14, "Reminder for economic assembly design": because Economic boards are panelised and routed
   out afterwards (≈ 0.2 mm tolerance), keep traces and components more than 0.3 mm from the board edge
   (https://jlcpcb.com/help/article/pcb-assembly-faqs-part-2).
3. The PCBA capabilities table lists "Edge Rails: Not necessary" and "Fiducials: Not necessary" for Economic PCBA
   (https://jlcpcb.com/capabilities/pcb-assembly-capabilities), and the process-edge article gives the guide-rail collision risk as the
   reason for wide process edges (https://jlcpcb.com/help/article/specifications-for-adding-process-edges-and-positioning-holes).

None of these says whether the 2.5 mm rule applies to the *board outline* of an Economic order that JLCPCB panelises itself.

**Our placement:** 37 of the 126 assembled parts have a component body closer than 2.5 mm to the board outline; none is closer than
0.3 mm, and the nearest copper/solder tail is 0.5 mm from the edge. The two largest cases are J1 (JST S2B-PH-SM4-TB, LCSC C295747,
side-entry, body 0.8 mm from the north edge, plug leaves through that edge) and J5001 (JST B2B-PH-SM4-TB, LCSC C160352, body 1.23 mm
from the west edge). Full per-part table and a top-view image are attached.

**Questions:**

1. Is this design, as described, accepted under **Economic PCBA**, or would any part of it force Standard PCBA?
2. Does the 2.5 mm body-to-edge rule apply to Economic orders that JLCPCB panelises itself? If yes, do the 37 listed parts fail it?
3. If it applies: are J1 (0.8 mm) and J5001 (1.23 mm) acceptable, or do they need special treatment (different orientation,
   a keep-out on the panel, extra rail, manual placement)?
4. Does JLCPCB's own panelisation / temporary process edges (rails, tooling holes, fiducials) resolve these cases — i.e. is the
   2.5 mm distance then measured to the panel rail rather than our board edge — without changing our functional board outline and
   without moving us to Standard PCBA?
5. For the "Single PCB" delivery option: where are the mouse-bite tabs placed, can we ask for tab positions to avoid connector
   pads on the south edge and J1 on the north edge, and what outline tolerance applies to the depanelised board?
6. Are there any additional charges for this (panelisation, rails/tooling, depanelisation or panel removal, engineering review,
   manual placement)? Our extended-part fee understanding is $3.07 per unique extended part; please correct if wrong.
7. Can you confirm in writing (or through a DFM report once we upload data) that the above is acceptable, and tell us what we
   should change if not?

We have not uploaded manufacturing files yet; if a quote/DFM check on a draft package is the right way to answer questions 1–4,
please say which files you need. Thank you.

**Attachments to send:**
- `affected_components.csv` (37 rows, body/courtyard/pad distance to edge, short of 2.5 mm by)
- `rb02f_edge_map.png` (top view, board edges, 2.5 mm keep-in line, J1, J5001 and closest parts highlighted)
- (optional) `rb02f_edge_map_ne.png`, `rb02f_edge_map_w.png`
