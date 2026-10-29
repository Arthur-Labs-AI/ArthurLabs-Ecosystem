# Approved Studio integration — 2026-10-29

Scope: promote the approved Infinite Desk experience to `/studio`; retain `/studio/concept` and its noindex metadata. No redesign, animation changes, release claims, shared header changes or Git mutations.

Implementation: extract the existing section composition into StudioExperience; both routes render that component. Add product-specific metadata to the official route. Update the former foundation-heading assertion and add production-route interaction coverage.

Verification: production export, TypeScript, browser regression suite; render official desktop/mobile and compare against the approved concept. Existing application/source capability audit remains applicable because product content and download policy are unchanged.
