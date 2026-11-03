'use strict';
// Client for the HoYoPlay "hyp-connect" API and the Sophon chunk API.
//
// !! Every response shape below is an ASSUMPTION reconstructed from public knowledge of these APIs and from the
// !! structure of the published hk4e manifest. It could not be exercised against the live APIs when this
// !! project was written (no network). All assumptions are isolated in the normalize*() functions, so if a live
// !! run shows a different shape, fix it there only. See docs/OPERATIONS.md.
const {getJson, postJson} = require('./safe_fetch');

const LAUNCHER_ID = 'VYTpXlbWo8'; // public HoYoPlay global launcher id (also used by the reference repo)
const HYP = 'https://sg-hyp-api.hoyoverse.com/hyp/hyp-connect/api';
const SOPHON = 'https://sg-public-api.hoyoverse.com/downloader/sophon_chunk/api';

const q = encodeURIComponent;

function assertOk(rsp, what) {
    if (!rsp || rsp.retcode !== 0 || !rsp.data) throw new Error(`${what}: retcode=${rsp && rsp.retcode} message=${rsp && rsp.message}`);
    return rsp.data;
}

function normalizeManifestItem(m, categoryNames, extra) {
    // m.manifest.id looks like "manifest_<hash>_<md5>"; m.manifest.checksum is the md5.
    return {
        id: String(m.category_id),
        field: categoryNames[String(m.category_id)] || m.matching_field || m.category_name || '',
        file_url: `${m.manifest_download.url_prefix}/${m.manifest.id}${m.manifest_download.url_suffix || ''}`,
        file_hash: m.manifest.checksum,
        ...extra(m),
    };
}

// Raw getBuild -> {tag, categories:[{id, field, file_url, file_hash, chunk_prefix, compressed, decompressed}]}
function normalizeBuild(raw, categoryNames) {
    let d = assertOk(raw, 'getBuild');
    return {
        tag: d.tag,
        categories: (d.manifests || []).map(m => normalizeManifestItem(m, categoryNames, m => ({
            chunk_prefix: m.chunk_download.url_prefix,
            compressed: m.stats.compressed_size,
            decompressed: m.stats.uncompressed_size,
        }))),
    };
}

// Raw getPatchBuild -> [{original: "7.0.0", categories:[{id, field, file_url, file_hash, diff_prefix, compressed, decompressed}]}]
// Assumes m.stats is keyed by original tag: {"7.0.0": {compressed_size, uncompressed_size}, ...}
function normalizePatches(raw, categoryNames) {
    let d = assertOk(raw, 'getPatchBuild'), byTag = new Map();
    for (let m of d.manifests || []) {
        for (let [tag, st] of Object.entries(m.stats || {})) {
            let item = normalizeManifestItem(m, categoryNames, () => ({
                diff_prefix: m.diff_download.url_prefix,
                compressed: st.compressed_size,
                decompressed: st.uncompressed_size,
            }));
            if (!byTag.has(tag)) byTag.set(tag, []);
            byTag.get(tag).push(item);
        }
    }
    return [...byTag].map(([original, categories]) => ({original, categories}));
}

// Same sources as TwintailTeam/game-manifests: icon from getGames (display.icon), background from getAllGameBasicInfo
// (backgrounds[0].background), live background only when backgrounds[0] is a video (type BACKGROUND_TYPE_VIDEO).
function normalizeAssets(raw, gameId, gamesList = []) {
    let d = assertOk(raw, 'getAllGameBasicInfo');
    let info = (d.game_info_list || []).find(g => g.game && g.game.id === gameId) || {};
    let bg = (info.backgrounds || [])[0] || {};
    let g = gamesList.find(x => x.id === gameId) || {};
    return {
        game_icon: (g.display && g.display.icon && g.display.icon.url) || (info.icon && info.icon.url) || '',
        game_background: (bg.background && bg.background.url) || '',
        game_live_background: (bg.type === 'BACKGROUND_TYPE_VIDEO' && bg.video && bg.video.url) || '',
    };
}

function branchCategoryNames(main) {
    let map = {};
    for (let c of main.categories || []) map[String(c.category_id)] = c.matching_field;
    return map;
}

async function loadGames(http) {
    return assertOk(await http.getJson(`${HYP}/getGames?launcher_id=${LAUNCHER_ID}&language=en-us`), 'getGames');
}

// getGameBranches for one game -> {main, names}
async function loadMainBranch(game, http) {
    let br = assertOk(await http.getJson(`${HYP}/getGameBranches?game_ids[]=${q(game.id)}&launcher_id=${LAUNCHER_ID}`), 'getGameBranches');
    let entry = (br.game_branches || []).find(b => b.game && b.game.id === game.id);
    if (!entry || !entry.main) throw new Error(`getGameBranches: no main branch for ${game.biz}`);
    return {main: entry.main, names: branchCategoryNames(entry.main), pre: entry.pre_download || null};
}

// Sophon query string, as TwintailTeam/game-manifests sends it: branch credentials + plat_app (+ tag for the live build).
const sophonParams = (b, game, withTag) =>
    `branch=${q(b.branch)}&package_id=${q(b.package_id)}&password=${q(b.password)}&plat_app=${q(game.id)}${withTag ? `&tag=${q(b.tag)}` : ''}`;

async function loadBuild(game, main, names, http) {
    return normalizeBuild(await http.getJson(`${SOPHON}/getBuild?${sophonParams(main, game, true)}`), names);
}

// Preload ("pre_download") of one game, exactly the way TwintailTeam/game-manifests does it: the pre_download branch
// of getGameBranches has its own branch/package_id/password/tag/diff_tags. Its build is read with getBuild, its patches
// with getPatchBuild (POST, parameters in the query string, plat_app = HoYoPlay game id).
// Returns null when no preload is published (pre_download === null). Throws on any API error, so the caller can decide
// to keep the previous preload instead of wiping it because of a transient failure.
async function loadPreload(game, pre, http) {
    if (!pre) return null;
    if (!pre.tag || !pre.branch || !pre.package_id || !pre.password) throw new Error(`preload of ${game.biz}: incomplete pre_download object`);
    let names = branchCategoryNames(pre);
    let params = sophonParams(pre, game, false);
    let build = normalizeBuild(await http.getJson(`${SOPHON}/getBuild?${params}`), names);
    let patches = [];
    if ((pre.diff_tags || []).length > 0) {
        let rawPatch = await http.postJson(`${SOPHON}/getPatchBuild?${params}`, undefined);
        patches = normalizePatches(rawPatch, names).filter(p => pre.diff_tags.includes(p.original));
    }
    return {tag: pre.tag, build, patches};
}

// game_id is left empty on purpose (all games), like upstream; the entry is picked by id.
async function loadAssets(game, games, http) {
    let basic = await http.getJson(`${HYP}/getAllGameBasicInfo?launcher_id=${LAUNCHER_ID}&language=en-us&game_id=`);
    return normalizeAssets(basic, game.id, games.games || []);
}

async function fetchGameState(biz, http = {getJson, postJson}) {
    let games = await loadGames(http);
    let game = (games.games || []).find(g => g.biz === biz);
    if (!game) throw new Error(`getGames: biz ${biz} not found`);

    let {main, names, pre} = await loadMainBranch(game, http);
    let assets = await loadAssets(game, games, http);
    let build = await loadBuild(game, main, names, http);
    let preload = {tag: null, error: null, data: null};
    try { preload.data = await loadPreload(game, pre, http); } catch (e) { preload.error = e.message; }

    let patches = [];
    if ((main.diff_tags || []).length > 0) {
        let rawPatch = await http.postJson(`${SOPHON}/getPatchBuild?${sophonParams(main, game, true)}`, undefined);
        patches = normalizePatches(rawPatch, names).filter(p => main.diff_tags.includes(p.original));
    }
    return {version: main.tag, build, patches, assets, preload};
}

// Multi-region games (bh3_global): one Sophon package per region server. HoYoPlay lists all of them under the same
// biz ("bh3_global") and tells them apart by game id, so cfg.regions = [{region_code, game_id, biz, required?}] is keyed
// by game id (the same ids upstream hard-codes). The first region is the primary one (version, assets, res_list_url).
// Safety rules:
//  - a required region that cannot be loaded fails the whole run (the old manifest is kept);
//  - an optional region that has no main branch, fails to load, or is on a different version than the primary region is
//    left out and reported as a ::warning:: (never mixed into a version it does not belong to).
async function fetchRegionalState(cfg, http = {getJson, postJson}, warn = m => console.log(`::warning::${m}`)) {
    let games = await loadGames(http);
    let regions = [], primary = null;
    for (let r of cfg.regions) {
        try {
            let game = {id: r.game_id, biz: r.biz};
            let {main, names, pre} = await loadMainBranch(game, http);
            if (primary && main.tag !== primary.version) {
                throw new Error(`version ${main.tag} differs from primary region version ${primary.version}`);
            }
            let build = await loadBuild(game, main, names, http);
            let preload = {data: null, error: null};
            try { preload.data = await loadPreload(game, pre, http); } catch (e) { preload.error = e.message; }
            let entry = {region_code: r.region_code, tag: main.tag, build, preload};
            if (!primary) primary = {version: main.tag, assets: await loadAssets(game, games, http)};
            regions.push(entry);
        } catch (e) {
            if (r.required || !primary) throw new Error(`required region ${r.region_code}: ${e.message}`);
            warn(`${cfg.file}: region ${r.region_code} (${r.game_id}) skipped: ${e.message}`);
        }
    }
    if (!primary || regions.length === 0) throw new Error('no region could be loaded');
    return {version: primary.version, assets: primary.assets, regions};
}

module.exports = {loadPreload, fetchGameState, fetchRegionalState, normalizeBuild, normalizePatches, normalizeAssets, LAUNCHER_ID, HYP, SOPHON};
