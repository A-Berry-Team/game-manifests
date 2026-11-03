# Security model

The pipeline automatically publishes files that a launcher will later trust to decide **what to download and
from where**. The threats that matter are therefore (a) a broken or hostile API response ending up in a
manifest, and (b) the automation itself being abused.

| Threat | Control |
|---|---|
| Vendor API returns an error / `null` / partial data | `saveManifest()` refuses it, keeps the old file, exit 1 |
| A generator silently loses versions | Validator rejects any manifest that drops a version |
| Compromised or spoofed API injects arbitrary download URLs | Output URL host allowlist (`config/allowed_hosts.json` -> `output_host_suffixes`), https only, checked in the validator for every new version |
| Generator talks to an unexpected host (SSRF-style redirects) | `safe_fetch`: https only, host allowlist re-checked on every redirect hop, no credentials in URLs, no redirects on POST |
| Hung or huge responses | 20 s timeout, 16 MiB cap, bounded retries (429 / 5xx / network only). Only the Kuro index files (tens of MB) get an explicit, per-game raised cap (256 MiB, 120 s) |
| Hard-coded third-party asset (Wuthering Waves icon on SteamGridDB) | Allowed by **exact URL** (`static_asset_urls`), never by host; `test/config.test.js` fails if config and allowlist drift apart |
| Bad data from the vendor CDN (empty / malformed index files, negative or non-integer sizes) | Kuro index files are fully validated before any size or hash is recorded; any error keeps the old manifest |
| Secrets in logs | Sophon URLs carry a `password` query parameter; `safe_fetch` logs only `origin + pathname` (covered by a test) |
| Over-privileged workflow token | `permissions: {}` at top level; the job asks only for `contents: write` and `pull-requests: write` |
| Overlapping runs corrupting state | `concurrency` group, no cancel-in-progress |
| Script injection through step outputs | Outputs are passed through `env:`, never interpolated into shell code |
| Path traversal via `repository.json` | Validator accepts only `^[a-z0-9_]+\.json$` |
| Supply chain (actions, npm) | **No npm dependencies.** Actions are referenced by major tag as in upstream PR #181; pin them to full commit SHAs and keep `.github/dependabot.yml` enabled |


## Preload-specific notes

- The preload requests carry the pre-download `password` in the query string, like every Sophon request; `safe_fetch`
  never logs query strings.
- The preload is regenerated on every run, so the validator checks **all** of its URLs against the allowlist
  (not only those of new versions) and rejects non-https URLs, a missing `game.full`, or a preload that is not newer
  than `latest_version`.
- A failing preload call can never delete or corrupt the version history: preload errors are isolated from the main
  build, and the old preload is kept only while it is still a future version.
