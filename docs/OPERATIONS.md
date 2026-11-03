# Operations

## Manual live run

```bash
node scripts/hoyo_manifests.js
node scripts/kuro_manifests.js
```

Game-specific checks:

- **`bh3_global`**: the log must not contain `region ... skipped` warnings. Regions are addressed by the
  HoYoPlay game id in `config/games.json -> bh3_global.regions[].game_id` (all five share `biz: bh3_global`). A skipped
  region means that id returned no main branch or a different version. Confirm that all five `region_code` values
  appear in `game.full` (10 entries, 2 per region).
- **`nap_global`**: `game.full` of the live version must contain many entries (the extra categories plus `game`),
  not just one. Compare the count with `TwintailTeam/game-manifests`.
- **`wuwa_global`**: the launcher index endpoint and background endpoint are configured in `config/games.json`.
  Kuro's current global endpoint uses `prod-alicdn-gamestarter.kurogame.com` and app key
  `50004_obOHXFrFanqsaIEOmuKroCcbZkQRBC7c`. If Kuro rotates either value, update both URLs and the host
  allowlists in `config/allowed_hosts.json`. If the generator stops with `launcher index: missing ...`, compare the real launcher index with
  `normalizeLauncher()` in `scripts/lib/kuro_launcher.js` and adjust only that function. Then verify the inferred diff
  hash once: `curl -s "<a diff file_url>" | md5sum` must equal that entry's `file_hash` in the published file.

- `structures match` -> the API shapes assumed in `scripts/lib/hoyo_sophon.js` are right.
- Differences are printed as `missing path ...`, `unexpected path ...` or `type mismatch ...`. Fix them in
  `normalizeBuild` / `normalizePatches` / `normalizeAssets` / `buildVersionEntry` only.
- If a call fails, the log shows `<METHOD> <origin+path> failed: HTTP <status>` (query strings are never logged).

Then spot-check a few `file_url` values in a browser or with `curl -I`, and only then enable the schedule.

## Preload checks

- While a pre-download is announced in the HoYoPlay launcher, `extra.preload` of that game must be non-empty, its
  `metadata.version` must be the announced version and `latest_version` must stay the live one.
  Compare with the same game in `TwintailTeam/game-manifests` (`extra.preload`); `metadata`, `res_list_url`, `diff_list_url`
  and the number of `game.full` / `game.diff` / `audio.*` entries should match.
- `::warning:: ... preload not refreshed` means the preload calls failed and the previous value was kept (or none was
  published). Re-run the workflow; if it persists, compare `getGameBranches -> pre_download` with `loadPreload()` in
  `scripts/lib/hoyo_sophon.js`.
- Never hand-edit `extra.preload`: it is overwritten on the next run.

## Repairing manifests written before the diff-URL fix

Older generator versions appended the category id twice to diff URLs (`.../10016/10016`). Run once on the committed manifests:

```bash
node scripts/tools/fix_doubled_diff_ids.js hk4e_global.json hkrpg_global.json nap_global.json bh3_global.json          # report
node scripts/tools/fix_doubled_diff_ids.js --write hk4e_global.json hkrpg_global.json nap_global.json bh3_global.json  # fix
```

Review the diff, commit it (the validator accepts it: no version is dropped).

## After upgrading: what heals itself and what does not

The live version is rebuilt on every run, so the first run after this upgrade fixes the **current** version of every
HoYoverse manifest (`nap_global` package list, `bh3_global` regions, icon / live background). Older versions are history
and are never rewritten; the Sophon API only describes the current version, so their gaps cannot be regenerated.
Their diff URLs can be repaired with `fix_doubled_diff_ids.js` (above).

## Normal operation

- The workflow runs every 3 hours and on demand. A red run means the validator rejected something or a generator
  failed; the committed manifests are untouched in that case.
- `PUSH_MODE` (repository variable): unset / anything else = push to `main`; `pr` = open a pull request.

## Adding a host to the allowlists

1. Confirm the domain is an official vendor domain.
2. Add the suffix to `output_host_suffixes` (URLs written into manifests) or the exact host to `api_hosts`
   (hosts generators may call) in `config/allowed_hosts.json`.
3. `npm test`, commit.

A missing host fails closed: the manifest is rejected and the run is red, with the offending host in the message.

## Adding another game later

Add it to `config/games.json` (`vendor`, `file`, names, vendor settings), to `repository.json`, and the vendor CDN
domains to `config/allowed_hosts.json`. `test/config.test.js` pins the current scope to five games on purpose: update
its `IN_SCOPE` list in the same change so the scope change is explicit in review.

## Local testing without network

`npm test` covers the validator (unit and CLI in a temporary git repo), `saveManifest`, `safe_fetch`
(timeouts, redirects, size cap, digest, log redaction), the schema tool, the config consistency checks and the HoYoverse (single- and multi-region) and Kuro pipelines on
mocked payloads.
