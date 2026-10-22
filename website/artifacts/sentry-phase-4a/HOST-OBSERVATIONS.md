# Shared host observations

During a capture-free full browser run, unrelated Rust/C compilation saturated the shared host. Observed load averages reached 27.41 with roughly 6.9GiB swap used. Previously fast, unchanged Nexus checks stretched to 29–100 seconds and timed out. The website-owned Playwright runner alone was interrupted; no application build or unrelated process was stopped.

The affected/interrupted result is retained for diagnosis. It is not a completed passing gate, and a fresh full run is required. Recorded frame-pacing measurements must state their host-load scope rather than imply a guaranteed frame rate.
