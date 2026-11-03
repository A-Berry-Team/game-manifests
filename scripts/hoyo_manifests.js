'use strict';
// Generates the HoYoverse manifests (Sophon / chunk based): hk4e_global, hkrpg_global, nap_global, bh3_global.
// Usage: node scripts/hoyo_manifests.js [append]
//   append  merge the newest version into the existing manifest found in scripts/generated/ (workflow mode)
const {existsSync, readFileSync, mkdirSync} = require('fs');
const {join} = require('path');
const {saveManifest} = require('./lib/save_manifest');
const {cmpVersion} = require('./lib/versions');
const {fetchGameState, fetchRegionalState} = require('./lib/hoyo_sophon');

const OUT_DIR = join(__dirname, 'generated');
const GAMES = require('../config/games.json');
const LANG_KEY = l => l.replace('-', '_'); // "en-us" -> "en_us" (used by diff_list_url)

function sizeStr(n) { return String(n); }

function buildVersionEntry(cfg, state) {
    let {version, build, patches, assets} = state;
    let byField = f => build.categories.find(c => c.field === f);
    let game = byField('game');
    if (!game) throw new Error('build has no "game" category');
    let patchesDesc = [...patches].sort((a, b) => cmpVersion(b.original, a.original));
    let newestPatch = patchesDesc[0];
    let patchCat = (p, f) => p.categories.find(c => c.field === f);

    let diffList = {game: '', ...Object.fromEntries(cfg.audio_languages.map(l => [LANG_KEY(l), '']))};
    if (newestPatch) {
        for (let f of ['game', ...cfg.audio_languages]) {
            let c = patchCat(newestPatch, f);
            if (c) diffList[f === 'game' ? 'game' : LANG_KEY(f)] = c.diff_prefix;
        }
    }

    let gameDiff = [], audioDiff = [];
    for (let p of patchesDesc) {
        // extra categories (nap_global) first, then game; same order as upstream
        for (let c of extraCategories(p.categories, cfg)) gameDiff.push({...diffItem(c, p.original), delete_files: []});
        let g = patchCat(p, 'game');
        if (g) gameDiff.push({...diffItem(g, p.original), delete_files: []});
        for (let l of cfg.audio_languages) {
            let a = patchCat(p, l);
            if (a) audioDiff.push({
                file_url: a.file_url, compressed_size: sizeStr(a.compressed), decompressed_size: sizeStr(a.decompressed),
                file_hash: a.file_hash, file_path: a.diff_prefix, diff_type: 'ldiff', original_version: p.original, language: l,
            });
        }
    }

    let audioFull = cfg.audio_languages.map(l => byField(l)).filter(Boolean).map(a => ({
        file_url: a.file_url, compressed_size: sizeStr(a.compressed), decompressed_size: sizeStr(a.decompressed),
        file_hash: a.file_hash, file_path: a.chunk_prefix, language: a.field, region_code: '',
    }));

    return {
        metadata: {
            versioned_name: `${cfg.name_prefix} ${version} ${cfg.name_suffix}`,
            version,
            download_mode: 'DOWNLOAD_MODE_CHUNK',
            game_hash: '',
            index_file: '',
            res_list_url: game.chunk_prefix,
            diff_list_url: diffList,
        },
        assets: {
            game_icon: assets.game_icon, game_background: assets.game_background, game_live_background: assets.game_live_background,
        },
        game: {
            full: [...extraCategories(build.categories, cfg), game].map(c => fullItem(c, '')),
            diff: gameDiff,
        },
        audio: {full: audioFull, diff: audioDiff},
    };
}

// Multi-region layout (bh3_global): no diffs, no audio packs. Every manifest of every region's build is one
// `game.full` entry tagged with its region_code, regions in config order, biggest manifest first inside a region
// (this is the order of the published bh3_global.json).
function buildRegionalEntry(cfg, state) {
    let {version, assets, regions} = state;
    let full = [];
    for (let r of regions) {
        let cats = [...r.build.categories].sort((a, b) => Number(b.decompressed) - Number(a.decompressed));
        if (cats.length === 0) throw new Error(`region ${r.region_code}: build has no manifests`);
        for (let c of cats) full.push({
            file_url: c.file_url, compressed_size: sizeStr(c.compressed), decompressed_size: sizeStr(c.decompressed),
            file_hash: c.file_hash, file_path: c.chunk_prefix, region_code: r.region_code,
        });
    }
    return {
        metadata: {
            versioned_name: `${cfg.name_prefix} ${version} ${cfg.name_suffix}`,
            version,
            download_mode: 'DOWNLOAD_MODE_CHUNK',
            game_hash: '',
            index_file: '',
            res_list_url: full[0].file_path,
            diff_list_url: {game: '', en_us: '', zh_cn: '', ja_jp: '', ko_kr: ''},
        },
        assets: {
            game_icon: assets.game_icon, game_background: assets.game_background, game_live_background: assets.game_live_background,
        },
        game: {full, diff: []},
        audio: {full: [], diff: []},
    };
}

// ---- Preload (extra.preload) --------------------------------------------------------------------------------------
// Same logic as TwintailTeam/game-manifests formatPreload(): the pre_download branch is described like a version
// (metadata / game / audio) but lives in `extra.preload`, not in game_versions. `{}` means "no preload published".
const MINI_OR_BASE = f => f === 'game' || /^mini-/.test(f);
const extraCategories = (cats, cfg) => cfg.include_extra_categories
    ? cats.filter(c => !MINI_OR_BASE(c.field) && !cfg.audio_languages.includes(c.field)) : [];
const fullItem = (c, region) => ({
    file_url: c.file_url, compressed_size: sizeStr(c.compressed), decompressed_size: sizeStr(c.decompressed),
    file_hash: c.file_hash, file_path: c.chunk_prefix, region_code: region,
});
const diffItem = (c, original) => ({
    file_url: c.file_url, compressed_size: sizeStr(c.compressed), decompressed_size: sizeStr(c.decompressed),
    file_hash: c.file_hash, file_path: c.diff_prefix, diff_type: 'ldiff', original_version: original,
});

function buildPreloadEntry(cfg, pre) {
    let {tag, build, patches} = pre;
    let byField = f => build.categories.find(c => c.field === f);
    let game = byField('game');
    if (!game) throw new Error('preload build has no "game" category');
    let patchesDesc = [...patches].sort((a, b) => cmpVersion(b.original, a.original));
    let patchCat = (p, f) => p.categories.find(c => c.field === f);
    let langs = cfg.audio_languages;

    let gameFull = [...extraCategories(build.categories, cfg), game].map(c => fullItem(c, ''));
    let audioFull = langs.map(byField).filter(Boolean).map(a => ({...fullItem(a, ''), language: a.field}));
    let gameDiff = [], audioDiff = [];
    for (let p of patchesDesc) {
        for (let c of extraCategories(p.categories, cfg)) gameDiff.push({...diffItem(c, p.original), delete_files: []});
        let g = patchCat(p, 'game');
        if (g) gameDiff.push({...diffItem(g, p.original), delete_files: []});
        for (let l of langs) {
            let a = patchCat(p, l);
            if (a) audioDiff.push({...diffItem(a, p.original), language: l});
        }
    }
    // diff_list_url mirrors the newest patch, exactly like the main entry does
    let newest = patchesDesc[0];
    let diffList = {game: '', ...Object.fromEntries(langs.map(l => [LANG_KEY(l), '']))};
    if (newest) for (let f of ['game', ...langs]) {
        let c = patchCat(newest, f);
        if (c) diffList[f === 'game' ? 'game' : LANG_KEY(f)] = c.diff_prefix;
    }
    return {
        metadata: {
            versioned_name: `${cfg.name_prefix} ${tag} Preload ${cfg.name_suffix}`,
            version: tag, download_mode: 'DOWNLOAD_MODE_CHUNK', game_hash: '', index_file: '',
            res_list_url: game.chunk_prefix, diff_list_url: diffList,
        },
        game: {full: gameFull, diff: gameDiff},
        audio: {full: audioFull, diff: audioDiff},
    };
}

// Multi-region preload (bh3_global): `game.full` holds every region's manifests (same order as the main entry), diffs
// come from the primary region only (as upstream, which reads branches[0]). A region whose preload tag differs from the
// primary region's is left out with a warning.
function buildRegionalPreloadEntry(cfg, regions, warn) {
    let withPre = regions.filter(r => r.preload && r.preload.data);
    if (withPre.length === 0) return null;
    let primary = regions[0].preload && regions[0].preload.data;
    if (!primary) throw new Error(`primary region ${regions[0].region_code} has no preload`);
    let full = [];
    for (let r of withPre) {
        if (r.preload.data.tag !== primary.tag) { warn(`${cfg.file}: preload of region ${r.region_code} (${r.preload.data.tag}) differs from primary (${primary.tag}); skipped`); continue; }
        let cats = [...r.preload.data.build.categories].sort((a, b) => Number(b.decompressed) - Number(a.decompressed));
        for (let c of cats) full.push(fullItem(c, r.region_code));
    }
    let diff = [];
    for (let p of [...primary.patches].sort((a, b) => cmpVersion(b.original, a.original))) {
        let g = p.categories.find(c => c.field === 'game');
        if (g) diff.push({...diffItem(g, p.original), delete_files: []});
    }
    return {
        metadata: {
            versioned_name: `${cfg.name_prefix} ${primary.tag} Preload ${cfg.name_suffix}`,
            version: primary.tag, download_mode: 'DOWNLOAD_MODE_CHUNK', game_hash: '', index_file: '',
            res_list_url: full[0].file_path, diff_list_url: {game: '', en_us: '', zh_cn: '', ja_jp: '', ko_kr: ''},
        },
        game: {full, diff},
        audio: {full: [], diff: []},
    };
}

// Sanity rules before a preload is published. A preload must be a *future* version and carry a downloadable game
// package; anything else is dropped (`{}`), never published.
function validatePreload(entry, latest) {
    if (!entry.game.full.length) return 'preload has no game.full entry';
    if (cmpVersion(entry.metadata.version, latest) <= 0) return `preload version ${entry.metadata.version} is not newer than latest ${latest}`;
    return null;
}

// Decide what `extra.preload` becomes for this run:
//  - preload published and valid      -> the fresh entry
//  - no preload published             -> {} (the pre-download ended or has not started)
//  - preload rejected by the rules    -> {} + warning
//  - API / payload error              -> keep the previous preload (never wipe it because of a transient failure) + warning,
//                                        but only while it is still newer than the live version
function resolvePreload(cfg, state, existing, latest, warn) {
    let keepOld = reason => {
        let old = existing && existing.extra && existing.extra.preload;
        let usable = old && old.metadata && cmpVersion(old.metadata.version, latest) > 0;
        warn(`${cfg.file}: preload not refreshed (${reason}); ${usable ? 'keeping the previous one' : 'publishing none'}`);
        return usable ? old : {};
    };
    let build;
    try {
        if (state.regions) {
            let errs = state.regions.map(r => r.preload && r.preload.error).filter(Boolean);
            if (errs.length) return keepOld(errs[0]);
            build = buildRegionalPreloadEntry(cfg, state.regions, warn);
        } else {
            let pre = state.preload || {};
            if (pre.error) return keepOld(pre.error);
            build = pre.data ? buildPreloadEntry(cfg, pre.data) : null;
        }
    } catch (e) { return keepOld(e.message); }
    if (!build) return {};
    let bad = validatePreload(build, latest);
    if (bad) { warn(`${cfg.file}: ${bad}; publishing none`); return {}; }
    return build;
}

function applyPreload(manifest, preload, cfg) {
    return {...manifest, extra: {...(cfg.extra || {}), ...((manifest.extra) || {}), preload}};
}

// Prepend the new version, keep every older one, newest first.
function mergeManifest(existing, entry, biz, cfg) {
    let old = (existing && Array.isArray(existing.game_versions)) ? existing.game_versions : [];
    let versions = [entry, ...old.filter(v => v?.metadata?.version !== entry.metadata.version)]
        .sort((a, b) => cmpVersion(b.metadata.version, a.metadata.version));
    let {version: _v, display_name: _d, biz: _b, latest_version: _l, game_versions: _g, ...kept} = existing || {};
    return {
        version: 1,
        display_name: cfg.display_name,
        biz,
        latest_version: versions[0].metadata.version,
        game_versions: versions,
        ...kept, // paths / assets / telemetry_hosts / extra, if the manifest already had them
    };
}

function loadExisting(cfg) {
    let p = join(OUT_DIR, cfg.file);
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

async function generateManifest(biz, {append = false, fetchState, existing, warn = m => console.log(`::warning::${m}`)} = {}) {
    let cfg = GAMES[biz];
    if (!cfg) throw new Error(`unknown biz ${biz}`);
    let regional = cfg.layout === 'regions';
    fetchState = fetchState || (regional ? () => fetchRegionalState(cfg) : () => fetchGameState(biz));
    let current = existing !== undefined ? existing : (append ? loadExisting(cfg) : null);
    let state = await fetchState(biz);
    // The live version is rebuilt on every run and replaces its previous entry (like upstream): backgrounds, diff lists and
    // package lists of the CURRENT version can change after its first publication. Older versions are never touched.
    let manifest = mergeManifest(current, regional ? buildRegionalEntry(cfg, state) : buildVersionEntry(cfg, state), biz, cfg);
    // The preload is refreshed on EVERY run, also when no new version was added: it appears, changes and disappears
    // independently of the live version.
    let preload = resolvePreload(cfg, state, current, manifest.latest_version, warn);
    return applyPreload(manifest, preload, cfg);
}

if (require.main === module) {
    (async () => {
        let append = process.argv.includes('append');
        mkdirSync(OUT_DIR, {recursive: true});
        // One game at a time: gentler on the vendor APIs, and logs of different games never interleave.
        for (let [biz, cfg] of Object.entries(GAMES)) {
            if (cfg.vendor !== 'hoyo') continue;
            if (cfg.status !== 'implemented') {
                console.log(`::notice::${biz} generator is "${cfg.status}"; skipped, manifest left untouched.`);
                continue;
            }
            await saveManifest(join(OUT_DIR, cfg.file), generateManifest(biz, {append}));
        }
    })();
}

module.exports = {generateManifest, buildVersionEntry, buildRegionalEntry, buildPreloadEntry, buildRegionalPreloadEntry, resolvePreload, mergeManifest};
