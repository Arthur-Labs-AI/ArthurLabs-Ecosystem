RFC9807 Appendix C vector data, normalized without changing field values from:
https://github.com/facebook/opaque-ke/blob/75fe4cdddb7946440054da0c8e7cdd73828af3f9/src/tests/rfc9807_vectors.rs

Upstream source SHA256:
4598f331aac513a1694375c969ba584d61209de32db32bd9d4e0b0aa04a3ef1a

Copyright (c) Meta Platforms, Inc. and affiliates. Upstream is MIT OR Apache-2.0;
the MIT license is retained alongside this file. These are PUBLIC published
vector passwords, seeds and keys, never Arthur OS/device secrets.

Only the ristretto255/SHA512/3DH suite is qualified here: C.1.1, C.1.2 and C.2.1.
The official vectors require Identity KSF. The separate temporary-code exercises
use upstream Argon2id; neither profile is N1-approved.
