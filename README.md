# game-manifests

Organization-owned game manifests for our launcher, generated **automatically** and **safely** from the
official vendor APIs. This project re-creates the way the public
[`TwintailTeam/game-manifests`](https://github.com/TwintailTeam/game-manifests) repository works (scheduled
GitHub Action -> per-vendor generator scripts -> manifest JSON files in the repository root), without mirroring
its files, and includes the hardening from its pull request
[#181](https://github.com/TwintailTeam/game-manifests/pull/181) ("Stop the bot from pushing broken manifests to
main (+ Node 24)").

## Scope

Exactly five games, nothing else:

| Game                  | `biz`          | Manifest file       | Vendor / mode                              | Generator status                  |
|-----------------------|----------------|---------------------|--------------------------------------------|-----------------------------------|
| Genshin Impact        | `hk4e_global`  | `hk4e_global.json`  | HoYoverse / Sophon chunks                  | implemented (live API verified) |
| Honkai: Star Rail     | `hkrpg_global` | `hkrpg_global.json` | HoYoverse / Sophon chunks                  | implemented (live API verified) |
| Zenless Zone Zero     | `nap_global`   | `nap_global.json`   | HoYoverse / Sophon chunks                  | implemented (live API verified) |
| Honkai Impact 3rd     | `bh3_global`   | `bh3_global.json`   | HoYoverse / Sophon chunks, 5 regions       | implemented (live API verified) |
| Wuthering Waves       | `wuwa_global`  | `wuwa_global.json`  | Kuro / raw index file + krdiff patches     | implemented (live API verified) |

## How it works (short version)

```
cron (every 3h) ──> stage existing manifests ──> run scripts/*.js (one per vendor, "append" mode)
                         ──> validate (.github/scripts/validate_manifests.js)
                              ├─ valid & additive  ──> push to main (or open a PR, see PUSH_MODE)
                              └─ broken / lossy    ──> restored to HEAD + run turns red
```

Details: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Security model: [`docs/SECURITY.md`](docs/SECURITY.md).
Day-to-day usage and first-run checklist: [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

## Preload (pre-download)

For every HoYoverse game the generator also publishes the **pre-download package** announced by HoYoPlay, in
`extra.preload` of the manifest, with the same shape Twintail uses (`metadata`, `game.full/diff`, `audio.full/diff`).
`extra.preload` is `{}` when no pre-download is available. It is **not** a `game_versions` entry, it is refreshed on
every run, and it disappears by itself once that version goes live. See `docs/ARCHITECTURE.md` ("Preload").

## Layout

```
.github/workflows/auto_update.yml     scheduled pipeline (Node 24)
.github/scripts/validate_manifests.js gate between generators and push
config/games.json                     per-game settings and implementation status
config/allowed_hosts.json             fail-closed host allowlists (API hosts / output URL hosts)
scripts/hoyo_manifests.js             HoYoverse generator (Sophon / chunk mode, single- and multi-region layouts)
scripts/kuro_manifests.js             Kuro generator (raw mode + krdiff)
scripts/lib/                          save_manifest, safe_fetch, hoyo_sophon, kuro_launcher, versions
scripts/tools/compare_schema.js       structural diff between two manifests
scripts/tools/fix_doubled_diff_ids.js one-off repair of diff URLs written by older generator versions
test/                                 60 tests, zero dependencies (node:test)
repository.json                       list of published manifests (single source of truth)
```

## Quick start

```bash
node --version        # >= 24 (tests also pass on 22)
npm test              # no dependencies to install
```
