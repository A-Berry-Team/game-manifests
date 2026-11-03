'use strict';
// Client for the Kuro Games launcher API (Wuthering Waves, "raw" download mode with krdiff patches).
//
// !! The launcher index shape below is an ASSUMPTION reconstructed from public knowledge of the Kuro launcher and
// !! from the published wuwa_global.json. It could not be exercised against the live API when this project was
// !! written. What IS grounded in real data: the indexFile.json layout ({resource:[{dest, md5, size, chunkInfos?}]})
// !! and the output structure. All launcher-shape assumptions live in normalizeLauncher() / normalizeBackground();
// !! if a live run shows a different shape, fix them there only (see docs/OPERATIONS.md).
const {getJson, getJsonDigest} = require('./safe_fetch');
const {cmpVersion} = require('./versions');

const pick = (obj, keys) => {
    for (let k of keys) if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
    return undefined;
};
const need = (v, what) => {
    if (v === undefined) throw new Error(`launcher index: missing ${what} (unexpected response shape)`);
    return v;
};
const VERSION_RE = /^\d+(\.\d+)*$/;

// Absolute URLs pass through untouched, relative paths are joined to the CDN base.
function absUrl(base, path) {
    if (/^https?:\/\//i.test(path)) return path;
    return `${String(base).replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`;
}

// Raw launcher index -> {version, cdn, indexFile, zipBase, patches:[{original, baseUrl, indexFile}], backgroundCode}
function normalizeLauncher(raw, cfg) {
    let d = raw && raw.default;
    if (!d || typeof d !== 'object') throw new Error('launcher index: no "default" section');
    // config values are looked up in default.config first, then in default itself
    let conf = {...d, ...(d.config && typeof d.config === 'object' ? d.config : {})};

    let cdns = (Array.isArray(conf.cdnList) ? conf.cdnList : []).filter(c => c && c.url);
    if (cdns.length === 0) throw new Error('launcher index: empty cdnList');
    let preferred = cdns.find(c => {
        try { return new URL(c.url).hostname === cfg.cdn_preferred_host; } catch { return false; }
    });
    if (!preferred) throw new Error(`launcher index: preferred CDN ${cfg.cdn_preferred_host} not in cdnList`);

    let version = String(need(pick(conf, ['version']), 'version'));
    if (!VERSION_RE.test(version)) throw new Error(`launcher index: invalid version "${version}"`);

    let patchList = pick(conf, ['patchConfig']) || [];
    if (!Array.isArray(patchList)) throw new Error('launcher index: patchConfig is not an array');
    let patches = patchList.map(p => {
        let original = String(need(pick(p, ['version', 'originalVersion']), 'patchConfig[].version'));
        if (!VERSION_RE.test(original)) throw new Error(`launcher index: invalid patch version "${original}"`);
        return {
            original,
            baseUrl: need(pick(p, ['baseUrl', 'resourcesBasePath']), `patchConfig[${original}].baseUrl`),
            indexFile: need(pick(p, ['indexFile']), `patchConfig[${original}].indexFile`),
        };
    });

    return {
        version,
        cdn: preferred.url,
        indexFile: need(pick(conf, ['indexFile']), 'indexFile'),
        zipBase: need(pick(conf, ['resourcesBasePath', 'baseUrl']), 'resourcesBasePath'),
        patches,
        backgroundCode: pick(conf.functionCode || {}, ['background']),
    };
}

// Raw indexFile.json -> total size in bytes (sum of every resource's size; compressed == decompressed in raw mode)
function totalSize(index, what) {
    let res = index && index.resource;
    if (!Array.isArray(res) || res.length === 0) throw new Error(`${what}: no "resource" list`);
    let total = 0;
    for (let r of res) {
        if (!r || typeof r.dest !== 'string' || !Number.isSafeInteger(r.size) || r.size < 0) {
            throw new Error(`${what}: malformed resource entry`);
        }
        total += r.size;
    }
    if (!Number.isSafeInteger(total) || total === 0) throw new Error(`${what}: implausible total size ${total}`);
    return total;
}

// Optional launcher background ({firstFrame, backgroundFile}); every field may be absent.
function normalizeBackground(raw) {
    if (!raw || typeof raw !== 'object') return {};
    return {
        game_background: pick(raw, ['firstFrame']) || '',
        game_live_background: pick(raw, ['backgroundFile']) || '',
    };
}

async function fetchBackground(cfg, code, http) {
    if (!code) return {};
    try {
        return normalizeBackground(await http.getJson(`${cfg.launcher_background_base}/${encodeURIComponent(code)}/en.json`));
    } catch (e) {
        console.log(`::warning::${cfg.file}: launcher background unavailable (${e.message}); falling back to previous / static assets.`);
        return {};
    }
}

// known: Set of versions that are already in the manifest. When the launcher's current version is among them we stop
// right after the (small) launcher index; the large index files are only downloaded for a genuinely new version.
async function fetchGameState(cfg, http = {getJson, getJsonDigest}, {known = new Set()} = {}) {
    let L = normalizeLauncher(await http.getJson(`${cfg.launcher_base_url}/${cfg.launcher_index_path}`), cfg);
    if (known.has(L.version)) return {version: L.version, upToDate: true};
    let big = {maxBytes: cfg.index_max_bytes, timeoutMs: cfg.index_timeout_ms};

    let indexUrl = absUrl(L.cdn, L.indexFile);
    let full = await http.getJsonDigest(indexUrl, big);
    let fullSize = totalSize(full.json, 'indexFile');

    // Sequential on purpose: each patch index is a large file and the CDN should not be hammered.
    let patches = [];
    for (let p of [...L.patches].sort((a, b) => cmpVersion(a.original, b.original))) {
        let url = absUrl(L.cdn, p.indexFile);
        let idx = await http.getJsonDigest(url, big);
        patches.push({
            original: p.original,
            file_url: url,
            file_hash: idx.md5,
            size: totalSize(idx.json, `patch index ${p.original}`),
            file_path: absUrl(L.cdn, p.baseUrl).replace(/\/*$/, '/'),
        });
    }

    let background = await fetchBackground(cfg, L.backgroundCode, http);
    return {
        version: L.version,
        indexFile: indexUrl,
        zipBase: absUrl(L.cdn, L.zipBase).replace(/\/+$/, ''),
        fullSize,
        patches,
        assets: background,
    };
}

module.exports = {fetchGameState, normalizeLauncher, normalizeBackground, totalSize, absUrl};
