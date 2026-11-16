# Source provenance

Vendored from https://github.com/ice-juice/file-locker-worker at commit
`896d7c53552ff7bd75b426bde4f9bf9925eb4e1b` on 2026-11-15. The sibling repository
required by the previous embed script was absent; keeping this source and lockfile
inside this repository makes future builds reproducible.

The original `handle.ts` and legacy unit tests remain as historical v1 behavior;
the production entrypoint now uses `handle-v2.ts`. Legacy network mutations are
disabled by the v2 router. Browser framing/decryption and HMAC canonicalization
reuse the upstream source. `@noble/ciphers` is MIT licensed; its bundled attribution
is retained by esbuild.

No production database IDs, bucket names or credentials are required for local
checks. Run `npm ci`, `npm run check`, then `node ../../scripts/embed-locker-worker.mjs`.
The v2 integration suite uses local Miniflare D1/R2 and never deploys a Worker.
