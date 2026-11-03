'use strict';
// Generates the Kuro Games manifests (raw download mode + krdiff): wuwa_global.
// Usage: node scripts/kuro_manifests.js [append]
//   append  merge the newest version into the existing manifest found in scripts/generated/ (workflow mode)
const {existsSync, readFileSync, mkdirSync} = require('fs');
const {join} = require('path');
const {saveManifest} = require('./lib/save_manifest');
const {cmpVersion} = require('./lib/versions');
const {fetchGameState} = require('./lib/kuro_launcher');

const OUT_DIR = join(__dirname, 'generated');
const GAMES = require('../config/games.json');

const sizeStr = n => String(n);

function buildVersionEntry(cfg, state, previousAssets = {}) {
    let st = cfg.static_assets || {};
    // Launcher assets change with every event: take the live ones, else keep what the previous version had,
    // else fall back to the reviewed static value from config/games.json.
    let asset = k => state.assets[k] || previousAssets[k] || st[k] || '';
    return {
        metadata: {
            versioned_name: `${cfg.name_prefix} ${state.version} ${cfg.name_suffix}`,
            version: state.version,
            download_mode: 'DOWNLOAD_MODE_RAW',
            game_hash: '',
            index_file: state.indexFile,
            res_list_url: state.zipBase,
            diff_list_url: {game: '', en_us: '', zh_cn: '', ja_jp: '', ko_kr: ''},
        },
        assets: {
            game_icon: st.game_icon || previousAssets.game_icon || '',
            game_background: asset('game_background'),
            game_live_background: asset('game_live_background'),
        },
        game: {
            full: [{
                file_url: state.indexFile, compressed_size: sizeStr(state.fullSize), decompressed_size: sizeStr(state.fullSize),
                file_hash: '', file_path: '', region_code: '',
            }],
            // oldest original version first, like the published file
            diff: state.patches.map(p => ({
                file_url: p.file_url, compressed_size: sizeStr(p.size), decompressed_size: sizeStr(p.size),
                file_hash: p.file_hash, file_path: p.file_path, diff_type: 'krdiff', original_version: p.original, delete_files: [],
            })),
        },
        audio: {full: [], diff: []},
    };
}

// Prepend the new version, keep every older one, newest first.
function mergeManifest(existing, entry, biz, cfg) {
    let old = (existing && Array.isArray(existing.game_versions)) ? existing.game_versions : [];
    let versions = [entry, ...old.filter(v => v?.metadata?.version !== entry.metadata.version)]
        .sort((a, b) => cmpVersion(b.metadata.version, a.metadata.version));
    return {
        version: 1,
        display_name: cfg.display_name,
        biz,
        latest_version: versions[0].metadata.version,
        game_versions: versions,
    };
}

function loadExisting(cfg) {
    let p = join(OUT_DIR, cfg.file);
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

async function generateManifest(biz, {append = false, fetchState, existing} = {}) {
    let cfg = GAMES[biz];
    if (!cfg || cfg.vendor !== 'kuro') throw new Error(`unknown kuro biz ${biz}`);
    let current = existing !== undefined ? existing : (append ? loadExisting(cfg) : null);
    let versions = (current && Array.isArray(current.game_versions)) ? current.game_versions : [];
    let known = new Set(versions.map(v => v?.metadata?.version));
    fetchState = fetchState || (() => fetchGameState(cfg, undefined, {known}));
    let state = await fetchState(biz);
    if (known.has(state.version)) return current; // already up to date, nothing was downloaded beyond the launcher index
    let previousAssets = versions[0]?.assets || {};
    return mergeManifest(current, buildVersionEntry(cfg, state, previousAssets), biz, cfg);
}

if (require.main === module) {
    (async () => {
        let append = process.argv.includes('append');
        mkdirSync(OUT_DIR, {recursive: true});
        for (let [biz, cfg] of Object.entries(GAMES)) {
            if (cfg.vendor !== 'kuro') continue;
            if (cfg.status !== 'implemented') {
                console.log(`::notice::${biz} generator is "${cfg.status}"; skipped, manifest left untouched.`);
                continue;
            }
            await saveManifest(join(OUT_DIR, cfg.file), generateManifest(biz, {append}));
        }
    })();
}

module.exports = {generateManifest, buildVersionEntry, mergeManifest};
