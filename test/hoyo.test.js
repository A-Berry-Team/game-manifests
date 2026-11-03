// NOTE: the raw API payloads below are ASSUMED shapes (see scripts/lib/hoyo_sophon.js). These tests prove that
// the pipeline turns that assumed shape into output structurally identical to the published hk4e manifest;
// they do not prove the live API matches the assumption. Run docs/OPERATIONS.md "first live run" for that.
const test = require('node:test');
const assert = require('node:assert');
const {readFileSync} = require('fs');
const {join} = require('path');
const {fetchGameState} = require('../scripts/lib/hoyo_sophon');
const {generateManifest, mergeManifest, buildVersionEntry} = require('../scripts/hoyo_manifests');
const {signature, diffSignatures} = require('../scripts/tools/compare_schema');

const CDN = 'https://autopatchhk.yuanshen.com/client_app/sophon';
const CATS = {game: 10016, 'zh-cn': 10017, 'en-us': 10018, 'ko-kr': 10019, 'ja-jp': 10020};
const mItem = (cat, prefixM, prefixC, key, st) => ({
    category_id: cat, manifest: {id: `manifest_aa_${key}`, checksum: key},
    manifest_download: {url_prefix: prefixM}, ...prefixC, stats: st,
});

// pre: null | {tag, diffTags}. calls: records every request so tests can assert on them.
function fakeHttp(tag, diffTags, pre = null, calls = []) {
    return {
        async getJson(url) {
            calls.push({method: 'GET', url});
            if (url.includes('getGames?')) return {retcode: 0, data: {games: [{id: 'GID', biz: 'hk4e_global', display: {icon: {url: 'https://fastcdn.hoyoverse.com/icon.png'}}}]}};
            if (url.includes('getGameBranches')) return {retcode: 0, data: {game_branches: [{game: {id: 'GID'}, main: {
                package_id: 'P', branch: 'B', password: 'PW', tag, diff_tags: diffTags,
                categories: Object.entries(CATS).map(([f, id]) => ({category_id: String(id), matching_field: f})),
            }, pre_download: pre && {
                package_id: 'PP', branch: 'PB', password: 'PPW', tag: pre.tag, diff_tags: pre.diffTags,
                categories: Object.entries(CATS).map(([f, id]) => ({category_id: String(id), matching_field: f})),
            }}]}};
            if (url.includes('getAllGameBasicInfo')) return {retcode: 0, data: {game_info_list: [{game: {id: 'GID'},
                backgrounds: [{type: 'BACKGROUND_TYPE_VIDEO', background: {url: 'https://launcher-webstatic.hoyoverse.com/b.webp'}, video: {url: 'https://launcher-webstatic.hoyoverse.com/l.webm'}, theme: {url: 'https://launcher-webstatic.hoyoverse.com/theme.webp'}}]}]}};
            if (url.includes('getBuild')) {
                let isPre = url.includes('branch=PB'), dir = isPre ? 'pre' : 'bld';
                return {retcode: 0, data: {tag: isPre ? pre.tag : tag, manifests: Object.values(CATS).map(id => mItem(id,
                    `${CDN}/manifests/br/${dir}`, {chunk_download: {url_prefix: `${CDN}/chunks/br/${dir}`}}, `${isPre ? 'p' : 'h'}${id}`, {compressed_size: 100 + id, uncompressed_size: 200 + id}))}};
            }
            throw new Error('unexpected ' + url);
        },
        async postJson(url, payload) {
            calls.push({method: 'POST', url, payload});
            let isPre = url.includes('branch=PB'), tags = isPre ? pre.diffTags : diffTags, dir = isPre ? 'prepat' : 'pat';
            let st = Object.fromEntries(tags.map(t => [t, {compressed_size: 5, uncompressed_size: 5}]));
            // real API: diff_download.url_prefix already ends with the category id
            return {retcode: 0, data: {manifests: Object.values(CATS).map(id => mItem(id,
                `${CDN}/manifests/br/${dir}`, {diff_download: {url_prefix: `${CDN}/diffs/br/${dir}/${id}`}}, `d${id}`, st))}};
        },
    };
}

const ref = JSON.parse(readFileSync(join(__dirname, 'fixtures/hk4e_reference.json'), 'utf8'));
const stateFor = (tag, tags, pre = null, calls = []) => fetchGameState('hk4e_global', fakeHttp(tag, tags, pre, calls));
const PRE = {tag: '7.2.0', diffTags: ['7.1.0', '7.0.0']};
const quiet = () => { let w = []; return {w, warn: m => w.push(m)}; };

test('generated manifest has the same structure as the published hk4e manifest', async () => {
    let m = await generateManifest('hk4e_global', {existing: null, fetchState: () => stateFor('7.1.0', ['7.0.0', '6.7.0'], PRE)});
    assert.deepStrictEqual(diffSignatures(signature(ref), signature(m)), []);
    assert.deepStrictEqual(Object.keys(m), ['version', 'display_name', 'biz', 'latest_version', 'game_versions', 'extra']);
    let e = m.game_versions[0];
    assert.strictEqual(e.metadata.versioned_name, 'GenshinImpact 7.1.0 (Global)');
    assert.strictEqual(e.metadata.diff_list_url.en_us, `${CDN}/diffs/br/pat/10018`); // no doubled id
    assert.strictEqual(e.game.diff[0].file_path, `${CDN}/diffs/br/pat/10016`);
    assert.deepStrictEqual(e.audio.full.map(a => a.language), ['en-us', 'zh-cn', 'ko-kr', 'ja-jp']);
    assert.deepStrictEqual(e.game.diff.map(d => d.original_version), ['7.0.0', '6.7.0']);
    // audio diffs grouped by original version, languages in a fixed order (as in the published file)
    assert.deepStrictEqual(e.audio.diff.map(d => `${d.original_version}/${d.language}`).slice(0, 5),
        ['7.0.0/en-us', '7.0.0/zh-cn', '7.0.0/ko-kr', '7.0.0/ja-jp', '6.7.0/en-us']);
    assert.strictEqual(typeof e.game.full[0].compressed_size, 'string');
});

test('append keeps older versions and is idempotent', async () => {
    let first = await generateManifest('hk4e_global', {existing: null, fetchState: () => stateFor('7.0.0', ['6.7.0'])});
    let second = await generateManifest('hk4e_global', {existing: first, fetchState: () => stateFor('7.1.0', ['7.0.0'])});
    assert.deepStrictEqual(second.game_versions.map(v => v.metadata.version), ['7.1.0', '7.0.0']);
    assert.strictEqual(second.latest_version, '7.1.0');
    let again = await generateManifest('hk4e_global', {existing: second, fetchState: () => stateFor('7.1.0', ['7.0.0'])});
    assert.deepStrictEqual(again, second);
});

test('API failure propagates (so saveManifest keeps the old file)', async () => {
    await assert.rejects(generateManifest('hk4e_global', {existing: null, fetchState: async () => { throw new Error('HTTP 500'); }}), /HTTP 500/);
});

test('API error payloads are rejected, not turned into manifests', async () => {
    let http = {async getJson() { return {retcode: -1, message: 'nope'}; }, async postJson() { return {}; }};
    await assert.rejects(fetchGameState('hk4e_global', http), /retcode=-1/);
});

test('preload: extra.preload has the published structure and the values Twintail publishes', async () => {
    let calls = [];
    let m = await generateManifest('hk4e_global', {existing: null, fetchState: () => stateFor('7.1.0', ['7.0.0'], PRE, calls)});
    let p = m.extra.preload;
    assert.strictEqual(p.metadata.versioned_name, 'GenshinImpact 7.2.0 Preload (Global)');
    assert.strictEqual(p.metadata.version, '7.2.0');
    assert.strictEqual(p.metadata.download_mode, 'DOWNLOAD_MODE_CHUNK');
    assert.strictEqual(p.metadata.res_list_url, `${CDN}/chunks/br/pre`);
    assert.deepStrictEqual(p.metadata.diff_list_url, {
        game: `${CDN}/diffs/br/prepat/10016`, en_us: `${CDN}/diffs/br/prepat/10018`, zh_cn: `${CDN}/diffs/br/prepat/10017`,
        ja_jp: `${CDN}/diffs/br/prepat/10020`, ko_kr: `${CDN}/diffs/br/prepat/10019`,
    });
    assert.deepStrictEqual(p.game.full.map(f => [f.file_hash, f.file_path, f.region_code]), [['p10016', `${CDN}/chunks/br/pre`, '']]);
    assert.deepStrictEqual(p.game.diff.map(d => [d.original_version, d.diff_type, d.file_path]),
        [['7.1.0', 'ldiff', `${CDN}/diffs/br/prepat/10016`], ['7.0.0', 'ldiff', `${CDN}/diffs/br/prepat/10016`]]);
    assert.deepStrictEqual(p.game.diff[0].delete_files, []);
    assert.deepStrictEqual(p.audio.full.map(a => a.language), ['en-us', 'zh-cn', 'ko-kr', 'ja-jp']);
    assert.strictEqual(p.audio.diff.length, 8);
    // preload is NOT a game version
    assert.deepStrictEqual(m.game_versions.map(v => v.metadata.version), ['7.1.0']);
    assert.strictEqual(m.latest_version, '7.1.0');
    // requests: preload branch credentials + plat_app; patches are POSTed with the parameters in the query string
    let post = calls.find(c => c.method === 'POST' && c.url.includes('branch=PB'));
    assert.ok(post && post.url.includes('package_id=PP') && post.url.includes('password=PPW') && post.url.includes('plat_app=GID'));
    assert.strictEqual(post.payload, undefined);
    assert.ok(calls.some(c => c.url.includes('getBuild') && c.url.includes('branch=PB') && c.url.includes('plat_app=GID')));
});

test('preload: no pre_download means an empty object', async () => {
    let m = await generateManifest('hk4e_global', {existing: null, fetchState: () => stateFor('7.1.0', ['7.0.0'], null)});
    assert.deepStrictEqual(m.extra, {preload: {}});
});

test('preload: refreshed on every run, also when the live version is already known', async () => {
    let first = await generateManifest('hk4e_global', {existing: null, fetchState: () => stateFor('7.1.0', ['7.0.0'], null)});
    let withPre = await generateManifest('hk4e_global', {existing: first, fetchState: () => stateFor('7.1.0', ['7.0.0'], PRE)});
    assert.strictEqual(withPre.extra.preload.metadata.version, '7.2.0');
    assert.deepStrictEqual(withPre.game_versions, first.game_versions);
    let again = await generateManifest('hk4e_global', {existing: withPre, fetchState: () => stateFor('7.1.0', ['7.0.0'], PRE)});
    assert.deepStrictEqual(again, withPre); // idempotent
    // the pre-download goes live: 7.2.0 becomes the version, preload disappears
    let live = await generateManifest('hk4e_global', {existing: withPre, fetchState: () => stateFor('7.2.0', ['7.1.0'], null)});
    assert.deepStrictEqual(live.game_versions.map(v => v.metadata.version), ['7.2.0', '7.1.0']);
    assert.deepStrictEqual(live.extra.preload, {});
});

test('preload: other extra settings and top-level blocks of an existing manifest are preserved', async () => {
    let first = await generateManifest('hk4e_global', {existing: null, fetchState: () => stateFor('7.1.0', ['7.0.0'], null)});
    let custom = {...first, paths: {exe_filename: 'GenshinImpact.exe'}, extra: {switches: {xxmi: true}, preload: {}}};
    let next = await generateManifest('hk4e_global', {existing: custom, fetchState: () => stateFor('7.2.0', ['7.1.0'], null)});
    assert.deepStrictEqual(next.paths, {exe_filename: 'GenshinImpact.exe'});
    assert.deepStrictEqual(next.extra.switches, {xxmi: true});
});

test('preload: an API failure keeps the previous preload instead of wiping it', async () => {
    let first = await generateManifest('hk4e_global', {existing: null, fetchState: () => stateFor('7.1.0', ['7.0.0'], PRE)});
    let broken = async () => { let s = await stateFor('7.1.0', ['7.0.0'], PRE); s.preload = {data: null, error: 'HTTP 500'}; return s; };
    let {w, warn} = quiet();
    let m = await generateManifest('hk4e_global', {existing: first, fetchState: broken, warn});
    assert.deepStrictEqual(m.extra.preload, first.extra.preload);
    assert.match(w[0], /keeping the previous one/);
    // ...but a previous preload that is no longer newer than the live version is never kept
    let stale = await generateManifest('hk4e_global', {existing: first, fetchState: async () => { let s = await broken(); s.version = '7.2.0'; return s; }, warn: quiet().warn});
    assert.deepStrictEqual(stale.extra.preload, {});
});

test('preload: a preload that is not newer than the live version is dropped with a warning', async () => {
    let {w, warn} = quiet();
    let m = await generateManifest('hk4e_global', {existing: null, warn, fetchState: () => stateFor('7.1.0', ['7.0.0'], {tag: '7.1.0', diffTags: ['7.0.0']})});
    assert.deepStrictEqual(m.extra.preload, {});
    assert.match(w[0], /not newer/);
});

test('preload: a malformed pre_download object never reaches the manifest', async () => {
    let http = fakeHttp('7.1.0', ['7.0.0'], {tag: '7.2.0', diffTags: []});
    let orig = http.getJson;
    http.getJson = async url => { let r = await orig(url); if (url.includes('getGameBranches')) delete r.data.game_branches[0].pre_download.password; return r; };
    let {w, warn} = quiet();
    let m = await generateManifest('hk4e_global', {existing: null, warn, fetchState: () => fetchGameState('hk4e_global', http)});
    assert.deepStrictEqual(m.extra.preload, {});
    assert.match(w[0], /incomplete pre_download/);
});

test('preload: nap_global includes the extra (non base/audio/mini) categories like upstream', () => {
    const {buildPreloadEntry} = require('../scripts/hoyo_manifests');
    const cfg = require('../config/games.json').nap_global;
    let cat = (field, n) => ({id: String(n), field, file_url: `u${n}`, file_hash: `h${n}`, chunk_prefix: `c${n}`, diff_prefix: `d${n}`, compressed: 1, decompressed: 2});
    let cats = ['game', 'res_a', 'mini-en-us', 'en-us', 'zh-cn', 'ko-kr', 'ja-jp'].map((f, i) => cat(f, i));
    let e = buildPreloadEntry(cfg, {tag: '3.4.0', build: {categories: cats}, patches: [{original: '3.3.0', categories: cats}]});
    assert.deepStrictEqual(e.game.full.map(f => f.file_hash), ['h1', 'h0']); // extra first, game last
    assert.deepStrictEqual(e.game.diff.map(f => f.file_hash), ['h1', 'h0']);
    assert.deepStrictEqual(e.audio.full.map(a => a.language), ['en-us', 'zh-cn', 'ko-kr', 'ja-jp']);
});

test('assets: icon from getGames, background from basic info, live background only for video backgrounds', async () => {
    let m = await generateManifest('hk4e_global', {existing: null, fetchState: () => stateFor('7.1.0', ['7.0.0'])});
    assert.deepStrictEqual(m.game_versions[0].assets, {
        game_icon: 'https://fastcdn.hoyoverse.com/icon.png',
        game_background: 'https://launcher-webstatic.hoyoverse.com/b.webp',
        game_live_background: 'https://launcher-webstatic.hoyoverse.com/l.webm',
    });
    const {normalizeAssets} = require('../scripts/lib/hoyo_sophon');
    let img = {retcode: 0, data: {game_info_list: [{game: {id: 'GID'}, backgrounds: [{type: 'BACKGROUND_TYPE_IMAGE', background: {url: 'b'}, theme: {url: 't'}}]}]}};
    assert.strictEqual(normalizeAssets(img, 'GID', []).game_live_background, '');
});

test('main requests follow upstream: plat_app + tag on getBuild, patches POSTed with the query string', async () => {
    let calls = [];
    await stateFor('7.1.0', ['7.0.0'], null, calls);
    let b = calls.find(c => c.url.includes('getBuild')), p = calls.find(c => c.method === 'POST');
    assert.ok(b.url.includes('plat_app=GID') && b.url.includes('tag=7.1.0') && b.url.includes('branch=B'));
    assert.ok(p.url.includes('getPatchBuild?') && p.url.includes('plat_app=GID') && p.url.includes('tag=7.1.0'));
    assert.strictEqual(p.payload, undefined);
});

test('the live version is rebuilt on every run and replaces its entry; older versions stay untouched', async () => {
    let first = await generateManifest('hk4e_global', {existing: null, fetchState: () => stateFor('7.0.0', ['6.7.0'])});
    let second = await generateManifest('hk4e_global', {existing: first, fetchState: () => stateFor('7.1.0', ['7.0.0'])});
    let stale = JSON.parse(JSON.stringify(second));
    stale.game_versions[0].assets.game_icon = '';       // an entry written by an older generator
    stale.game_versions[1].assets.game_icon = 'KEEP';   // history must not be rewritten
    let fixed = await generateManifest('hk4e_global', {existing: stale, fetchState: () => stateFor('7.1.0', ['7.0.0'])});
    assert.strictEqual(fixed.game_versions[0].assets.game_icon, 'https://fastcdn.hoyoverse.com/icon.png');
    assert.strictEqual(fixed.game_versions[1].assets.game_icon, 'KEEP');
    assert.strictEqual(fixed.game_versions.length, 2);
});

test('nap_global main entry includes the extra categories in game.full and game.diff (before game)', () => {
    const {buildVersionEntry} = require('../scripts/hoyo_manifests');
    const cfg = require('../config/games.json').nap_global;
    let cat = (field, n) => ({id: String(n), field, file_url: `u${n}`, file_hash: `h${n}`, chunk_prefix: `c${n}`, diff_prefix: `d${n}`, compressed: 1, decompressed: 2});
    let cats = ['game', 'res_a', 'res_b', 'mini-en-us', 'en-us', 'zh-cn', 'ko-kr', 'ja-jp'].map((f, i) => cat(f, i));
    let patchCats = cats.filter(c => c.field !== 'res_b'); // res_b has no patch for this tag
    let e = buildVersionEntry(cfg, {version: '3.3.0', build: {categories: cats}, patches: [{original: '3.2.0', categories: patchCats}], assets: {game_icon: '', game_background: '', game_live_background: ''}});
    assert.deepStrictEqual(e.game.full.map(f => f.file_hash), ['h1', 'h2', 'h0']);
    assert.deepStrictEqual(e.game.diff.map(f => f.file_hash), ['h1', 'h0']);
    assert.strictEqual(e.metadata.res_list_url, 'c0');
    assert.strictEqual(e.audio.full.length, 4); // mini-* never leaks into audio
});

test('hk4e/hkrpg/bh3 are NOT given extra categories', () => {
    const G = require('../config/games.json');
    assert.deepStrictEqual(Object.keys(G).filter(k => G[k].include_extra_categories), ['nap_global']);
});
