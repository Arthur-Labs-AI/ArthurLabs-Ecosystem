# User preview screenshots 01 — HOLD / NOT RELEASED

These are user-provided screenshots of the private JLCPCB preview, preserved verbatim. File hashes and provenance are in provenance.json. The user subsequently confirmed these are from **the old files**, rather than either corrected candidate. No exact upload filename/hash, selected connector rotation or manual-override state is visible. The old local RC1 CPL has five north headers at 0 degrees and J1 at 270 degrees.

## Visible findings

- The board orientation can be recognized from the five-connector edge at the top/north in the top screenshot and the empty XIAO/manual-installation region toward the bottom/south.
- In the oblique 3D image, all five north-edge mating cavities are visible from the board-interior/south side. The rendered openings therefore face inward/south, contrary to the required north-facing direction. This rendered state fails the intended opening-direction check.
- The top view shows the rendered five-header signal-terminal side toward the north edge, with the broad housing extending south. That is consistent with the inward 3D appearance and disagrees with the authoritative PCB requirement for signal tails south (Y=8.00 mm) and retention lands north (Y=2.25 mm). This is a gross orientation observation, not a measured four-terminal overlay or pin-1/net verification.
- J1's rendered signal-terminal side appears east/right, with its main case to the west/left. This suggests its mating direction is west/inward, whereas the intended opening is east/outward. The east-facing exposed case wall in the oblique screenshot supports that concern. Treat J1 as suspect/on hold; the cavity is not directly exposed to the camera, so this is less conclusive than the five visible north-header cavities.
- Other polarized components are visible, but this scale lacks the numbered-pad/net/physical marking detail needed to qualify all 29 oriented placements. No additional angle changes are justified from these screenshots alone.

## Interpretation after user clarification

The user confirmed these show the old files. The visible inward five-header cavities therefore corroborate the original reversal report and support testing RC2 at 180 degrees. These are **before** screenshots; they do not verify either corrected candidate. The public exact-part numbered-pad analysis remains the independent support for the proposed angle, rather than an arbitrary visual flip.

J1 remains 270 degrees in the main candidate, as requested. The old screenshots also support the existing J1 mismatch concern. Its separate 90-degree alternative, which already has all five north headers at 180 degrees, is appropriate for the next preview test if evaluating all six connectors together. This does not approve J1; its east-facing cavity and numbered signal-terminal registration still need an after screenshot.

## Required follow-up

For the next upload, record the corrected CPL filename and any manual overrides. Provide a selected north header with its displayed Rotation and the 2D terminal/land overlay, plus an oblique view from outside the north edge. Check all five cavities and all four terminals. For J1, show the east-side mouth, selected Rotation, and signal-pin registration (pin 1 VBAT at board 41.55,39.30; pin 2 GND at 41.55,37.30 mm). Match numbered terminals and physical cavities, not just a colored orientation dot.

No PCB, schematic, manufacturing CSV, exporter policy or candidate checksum changed during this screenshot review. The original RC2 manifest/bundle remain the pre-screenshot offline candidate; this separate evidence directory adds observations without claiming that the candidate is verified. No staging, commit, push or assembly approval performed.
