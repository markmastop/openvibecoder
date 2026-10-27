# Open Vibe Coder 0.3.0

Built on 27 October 2026 for macOS Apple Silicon (arm64).

- `Open Vibe Coder_0.3.0_macos-arm64.zip` contains the complete app, including Node.js 22.22.2 and the pinned frontend build runtime.
- `SHA256SUMS.txt` records the ZIP checksum.

Extract the ZIP and open `Open Vibe Coder.app`. You can move it to Applications. The app is locally ad-hoc signed and has not been notarized by Apple. Existing desktop settings and projects use the same app identifier and data directory.

Verification: native Rust bridge test passed; bundled backend reports 0.3.0 and loads English resources; session authentication and the signed Node runtime's sandbox self-check passed; the desktop interface was opened and inspected; the app signature and ZIP integrity were verified.

The source was built with Rust 1.99.1 using `npm run desktop:build -- --keep-version --bundles app`. This release contains only the macOS arm64 build.
