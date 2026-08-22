## 2026.08.21.1

**Changed:** `createDriver` now validates config up front instead of letting bad values fail deep inside a nix invocation: a blank or non-string entry in `packages` is rejected immediately (previously it built an invalid flake ref like `nixpkgs#` and only surfaced as an opaque nix error), and a non-positive `timeout` is rejected instead of causing every command to time out immediately. When the `nix` binary itself is missing from `PATH`, the error result now says so explicitly ("Could not run \"nix\" — is it installed and on PATH?") instead of a bare "No such file or directory" that doesn't name what's missing.

## 2026.07.18.1

**Changed:** Version bump only, no code changes.
