# Architecture

## 1. Manifest format

One JSON file per game in the repository root, listed in `repository.json`. For the HoYoverse (Sophon / chunk)
games the structure was taken from the published `hk4e_global.json` and is encoded in
`test/fixtures/hk4e_reference.json`:

```
{ version, display_name, biz, latest_version,
  game_versions: [ {                       // newest first, every old version is kept
      metadata: { versioned_name, version, download_mode, game_hash, index_file, res_list_url, diff_list_url{game,en_us,zh_cn,ja_jp,ko_kr} },
      assets:   { game_icon, game_background, game_live_background },
      game:     { full: [ {file_url, compressed_size, decompressed_size, file_hash, file_path, region_code} ],
                  diff: [ {..., diff_type, original_version, delete_files} ] },
      audio:    { full: [ {..., language, region_code} ], diff: [ {..., diff_type, original_version, language} ] }
  } ] }
```

Sizes are strings. Key order is stable so that diffs in Git stay small.

Per-vendor differences inside the same structure (all taken from the published manifests):

| | HoYoverse single region | `bh3_global` | `wuwa_global` |
|---|---|---|---|
| `download_mode` | `DOWNLOAD_MODE_CHUNK` | `DOWNLOAD_MODE_CHUNK` | `DOWNLOAD_MODE_RAW` |
| `metadata.index_file` | `""` | `""` | URL of `indexFile.json` |
| `metadata.res_list_url` | chunk prefix of the game package | chunk prefix of the primary region | `.../zip` base URL (no trailing slash) |
| `game.full` | 1 entry, `region_code: ""` | 2 entries per region (big + small manifest), `region_code` = `glb_official`, `jp_official`, `kr_official`, `overseas_official`, `asia_official` | 1 entry = the index file, `file_hash`/`file_path`/`region_code` empty, sizes = sum of the index |
| `game.diff` | `ldiff`, newest original first | always `[]` | `krdiff`, oldest original first, `file_hash` = MD5 of that patch's index file |
| `audio` | one pack per language | empty | empty |

## 2. Pipeline

`.github/workflows/auto_update.yml`, in order:

1. **Checkout + Node 24** (action versions as in upstream PR #181).
2. **`npm test`** - the pipeline refuses to run generators if its own safety net is broken.
3. **Stage existing manifests**: every file listed in `repository.json` is copied to `scripts/generated/`.
4. **Run generators**: every `scripts/*.js` is run as `node <script> append`. A failing script becomes a
   `::warning::` and the other vendors still run (PR #181: `run:` steps use `bash -e`, so the old
   `status=$?` branch never ran).
5. **Move back** the generated files (same `repository.json` list).
6. **Validate** (`validate_manifests.js`).
7. **Detect changes**, then either **push directly to `main`** (default) or **open a pull request** when the
   repository variable `PUSH_MODE` is `pr`.
8. **Fail the run** if the validator rejected anything, so rejections are noticed instead of discovered later.

### One list, not two

Upstream had a "move to generated" list and a "push" list maintained by hand. When they drifted
(`sdsgc_global.json` was in one but not the other) a generator started from an empty file and silently dropped
a version. Here both lists come from `repository.json` via `jq`, so they cannot drift.

## 3. Generators

A generator exposes `generateManifest(biz, {append})` returning a manifest object (or throwing). It never writes
files itself: every script ends with `saveManifest(path, generateManifest(...))` (from PR #181), which refuses
`null`, empty or failed results, keeps the existing file and sets exit code 1.

`append` mode loads the existing manifest, **rebuilds the live version and replaces its entry** (its backgrounds, package
and diff lists can change after the first publication; this is what upstream does too), keeps every older version
untouched and returns the result. Re-running with no vendor change returns the same object (idempotent). This applies to
the HoYoverse generator; the Kuro generator still stops early when its version is already present.

### HoYoverse (`scripts/hoyo_manifests.js`, `scripts/lib/hoyo_sophon.js`)

For each game: `getGames` (id for the `biz`, and the **icon**: `display.icon.url`) -> `getGameBranches` (main branch:
`package_id`, `branch`, `password`, `tag`, `diff_tags`, category ids) -> `getAllGameBasicInfo` (**background** =
`backgrounds[0].background.url`; **live background** = `backgrounds[0].video.url`, only when that background's type is
`BACKGROUND_TYPE_VIDEO`, otherwise empty) -> Sophon `getBuild` (full manifests; query: branch credentials, `plat_app` =
game id, `tag`) -> Sophon `getPatchBuild` (POST, same query string, no body; diffs from each `diff_tags` version).

`nap_global` has many more Sophon categories than `game` and the audio packs. Every category that is not `game`, an
audio language or `mini-*` is published too (`include_extra_categories` in `config/games.json`), listed **before** `game`
in `game.full` and, per patch, in `game.diff` (only for patches that contain that category). Without them the game does not install.
`normalizeBuild` / `normalizePatches` / `normalizeAssets` are the only functions that know the raw response
shapes; `buildVersionEntry` is a pure function from normalized state to the manifest entry.

#### Multi-region layout (`bh3_global`)

`config/games.json -> bh3_global.regions` lists `{region_code, game_id, biz, required?}`. HoYoPlay publishes all five
regions under the **same** `biz` (`bh3_global`) and tells them apart by **game id** (`glb_official` 5TIVvvcwtM,
`jp_official` g0mMIvshDb, `kr_official` uxB4MC7nzC, `overseas_official` bxPTXSET5t, `asia_official` wkE5P5WsIf), each
with its own Sophon package. Regions are therefore addressed by id; `getGames` is only used for the icon. `fetchRegionalState` loads them in order; the first (`glb_official`) is required and is the
source of the version, the assets and `res_list_url`. Any other region that is missing, fails, or is on a different
version than the primary one is **left out with a `::warning::`** instead of being mixed into the wrong version or
blocking the update. Every manifest of a region's build becomes one `game.full` entry (biggest first).

### Kuro (`scripts/kuro_manifests.js`, `scripts/lib/kuro_launcher.js`)

1. Read the launcher index (`launcher_base_url/index.json`) and normalize it (`normalizeLauncher`): version, preferred CDN
   (`cdn_preferred_host`, never "highest priority"), index file path, zip base path, patch list.
2. **If that version is already in the manifest, stop here** (a normal 3-hourly run costs one small request).
3. Otherwise download `indexFile.json` (real layout: `{resource:[{dest, md5, size, chunkInfos?}]}`), validate every
   entry and sum the sizes; download each patch's index file the same way (sequentially) and record its MD5 + summed size.
4. Assets: launcher background if the launcher exposes one (best effort) -> background of the previous version ->
   static value from config. The icon is always the reviewed static one from config.

Any failure in steps 1 to 3 fails the run for that game (fail closed, old manifest kept).

## 4. Validator

Every manifest from `repository.json` that differs from `HEAD` (or is new) must:

- parse as JSON and be an object (not `null`, not an array);
- have a non-empty `game_versions` and a `latest_version`;
- keep the same `biz`;
- keep **every** version `HEAD` had;
- (addition) only reference `https` URLs on allowlisted vendor hosts in versions that are new.

Anything else is restored to `HEAD` (or deleted, if it was a new file) and listed in the `rejected` step output.
Good manifests in the same run still ship.

Differences from upstream PR #181, all deliberate: untracked (new) manifests are validated too; manifest file
names must match `^[a-z0-9_]+\.json$`; URL host allowlist (plus an exact-URL list, `static_asset_urls`, for reviewed
hard-coded assets such as the Wuthering Waves icon).


## Preload (`extra.preload`)

This mirrors how `TwintailTeam/game-manifests` builds it (`formatPreload()` in its `hoyo_manifests.js`), with extra safety rules.

**Where the data comes from.** `getGameBranches` returns, for every game, a `main` branch and a `pre_download` branch
(`null` while no pre-download is announced). `pre_download` has its own `branch`, `package_id`, `password`, `tag` and
`diff_tags`. The preload is described with two more Sophon calls on *that* branch:

| Call | Method | Parameters |
|------|--------|------------|
| `getBuild` | GET | `branch`, `package_id`, `password`, `plat_app=<game id>` (query string) |
| `getPatchBuild` | POST, no body | same four parameters in the query string; result filtered to `pre_download.diff_tags` |

**Shape.** Same as a `game_versions` entry minus `assets`:

```
extra.preload = {
  metadata: {versioned_name: "<Name> <tag> Preload (Global)", version: <tag>, download_mode, game_hash, index_file,
             res_list_url: <game chunk prefix>, diff_list_url: {game, en_us, zh_cn, ja_jp, ko_kr}},
  game:  {full: [...], diff: [...]},      // diff: one entry per diff_tag, newest first, diff_type "ldiff"
  audio: {full: [...], diff: [...]}       // en-us, zh-cn, ko-kr, ja-jp
}
```

`diff_download.url_prefix` already ends with the category id, so it is used as-is for `file_path` and
`diff_list_url` (never append the id again).

**Per game.**

- `hk4e_global`, `hkrpg_global`: game + 4 audio packs, diffs per `diff_tag`.
- `nap_global`: additionally every category that is not `game`, an audio language or `mini-*`
  (`include_extra_categories` in `config/games.json`), listed before `game` in `game.full` / `game.diff`, as upstream does.
- `bh3_global`: no audio, `diff_list_url` empty. `game.full` has the manifests of every region that has a preload
  (biggest first, tagged with `region_code`); `game.diff` comes from the primary region only (upstream reads `branches[0]`).
  A region whose preload tag differs from the primary one is skipped with a `::warning::`.
- `wuwa_global`: Kuro publishes no Sophon preload; its manifest is untouched by this feature.

**Lifecycle (refreshed on every run).** Unlike versions, which are only ever added, the preload is recomputed on each run,
even when no new version was found:

| Situation | Result |
|-----------|--------|
| `pre_download` published and valid | fresh `extra.preload` |
| `pre_download` is `null` | `{}` (not started, ended, or already live) |
| preload version is not newer than the live one, or it has no `game.full` | `{}` + warning |
| preload API call / payload fails | the previous preload is kept + warning, but only while it is still newer than the live version |

Other keys of an existing manifest (`paths`, `assets`, `telemetry_hosts`, other `extra.*` settings, or `cfg.extra` from
`config/games.json`) are preserved when the file is rewritten; the generator only owns `extra.preload`.

**Validation gate.** `.github/scripts/validate_manifests.js` additionally requires `extra.preload` to be `{}` or a
well-formed entry for a version newer than `latest_version`, and checks that *all* its URLs are https and on the host
allowlist (the preload is rewritten on every run, so the "new versions only" URL rule is not enough). A rejected
manifest is restored to HEAD like any other.
