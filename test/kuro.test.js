// NOTE: the launcher index below is an ASSUMED shape (see scripts/lib/kuro_launcher.js); the indexFile.json layout
// ({resource:[{dest, md5, size, chunkInfos?}]}) is real. These tests prove the pipeline turns that into output that is
// structurally identical to the published wuwa_global.json (test/fixtures/wuwa_reference.json), and that failures
// are fail-closed. They do not prove the live launcher API matches the assumption.
const test = require('node:test');
const assert = require('node:assert');
const {readFileSync} = require('fs');
const {join} = require('path');
const {fetchGameState, normalizeLauncher, totalSize, absUrl} = require('../scripts/lib/kuro_launcher');
const {generateManifest, buildVersionEntry} = require('../scripts/kuro_manifests');
const {signature, diffSignatures} = require('../scripts/tools/compare_schema');

const cfg = require('../config/games.json').wuwa_global;
const ref = JSON.parse(readFileSync(join(__dirname, 'fixtures/wuwa_reference.json'), 'utf8'));
const CDN = 'https://hw-pcdownload-aws.aki-game.net';
const DIR = '/launcher/game/G153/50004';

const launcher = (version = '3.7.1', extra = {}) => ({default: {
    cdnList: [{url: 'https://hw-pcdownload-qcloud.aki-game.net', P: 10}, {url: CDN, P: 5}],
    config: {
        version, indexFile: `${DIR}/${version}/RND/resource/50004/${version}/indexFile.json`, resourcesBasePath: `${DIR}/${version}/RND/zip`,
        patchConfig: ['1.1.0', '1.0.0', '1.0.2'].map(o => ({version: o, baseUrl: `${DIR}/3.7.0/PREV/zip`, indexFile: `${DIR}/${version}/RND/resource/50004/${version}/${o}/indexFile.json`})),
    },
    functionCode: {background: 'BGCODE'},
    ...extra,
}});
const index = sizes => ({resource: sizes.map((size, i) => ({dest: `f${i}.pak`, md5: 'x', size}))});

function fakeHttp({version = '3.7.1', launcherExtra, bg = {firstFrame: 'https://hw-pcdownload-qcloud.aki-game.net/launcher/clientUpload/bg.webp', backgroundFile: 'https://hw-pcdownload-qcloud.aki-game.net/launcher/clientUpload/bg.mp4'}, indexes = {}} = {}) {
    let calls = [];
    return {calls,
        async getJson(url) {
            calls.push(url);
            if (url.endsWith('/index.json')) return launcher(version, launcherExtra);
            if (url.includes('/background/')) { if (!bg) throw new Error('HTTP 404'); return bg; }
            throw new Error('unexpected ' + url);
        },
        async getJsonDigest(url, opts) {
            calls.push(url);
            assert.ok(opts.maxBytes >= 256 * 1024 * 1024, 'index files need the raised size cap');
            let key = /resource\/50004\/[^/]+\/(?:([^/]+)\/)?indexFile\.json$/.exec(url)[1] || 'full';
            let sizes = indexes[key] || (key === 'full' ? [60, 40] : key === '1.0.0' ? [90] : [70, 20]);
            return {json: index(sizes), md5: `md5_${key}`, bytes: 123};
        },
    };
}

test('generated wuwa manifest has the same structure as the published one', async () => {
    let m = await generateManifest('wuwa_global', {existing: null, fetchState: () => fetchGameState(cfg, fakeHttp())});
    assert.deepStrictEqual(diffSignatures(signature(ref), signature(m)), []);
    assert.deepStrictEqual(Object.keys(m), ['version', 'display_name', 'biz', 'latest_version', 'game_versions']);
    let e = m.game_versions[0];
    assert.strictEqual(e.metadata.versioned_name, 'WutheringWaves 3.7.1 (Global)');
    assert.strictEqual(e.metadata.download_mode, 'DOWNLOAD_MODE_RAW');
    assert.strictEqual(e.metadata.index_file, `${CDN}${DIR}/3.7.1/RND/resource/50004/3.7.1/indexFile.json`);
    assert.strictEqual(e.metadata.res_list_url, `${CDN}${DIR}/3.7.1/RND/zip`); // no trailing slash, like the published file
    assert.deepStrictEqual(e.game.full, [{file_url: e.metadata.index_file, compressed_size: '100', decompressed_size: '100', file_hash: '', file_path: '', region_code: ''}]);
});

test('preferred CDN is used even when another one has a higher priority', async () => {
    let s = await fetchGameState(cfg, fakeHttp());
    assert.ok(s.indexFile.startsWith(CDN));
});

test('diffs: oldest original first, md5 of the index, summed size, krdiff, file_path with trailing slash', async () => {
    let m = await generateManifest('wuwa_global', {existing: null, fetchState: () => fetchGameState(cfg, fakeHttp())});
    let d = m.game_versions[0].game.diff;
    assert.deepStrictEqual(d.map(x => x.original_version), ['1.0.0', '1.0.2', '1.1.0']);
    assert.deepStrictEqual(d.map(x => x.file_hash), ['md5_1.0.0', 'md5_1.0.2', 'md5_1.1.0']);
    assert.deepStrictEqual(d.map(x => x.compressed_size), ['90', '90', '90']);
    assert.ok(d.every(x => x.diff_type === 'krdiff' && Array.isArray(x.delete_files) && x.file_path === `${CDN}${DIR}/3.7.0/PREV/zip/`));
    assert.strictEqual(d[0].file_url, `${CDN}${DIR}/3.7.1/RND/resource/50004/3.7.1/1.0.0/indexFile.json`);
});

test('assets: live background, else previous version, else static config; icon is always the reviewed static one', async () => {
    let live = await generateManifest('wuwa_global', {existing: null, fetchState: () => fetchGameState(cfg, fakeHttp())});
    assert.match(live.game_versions[0].assets.game_background, /bg\.webp$/);
    assert.strictEqual(live.game_versions[0].assets.game_icon, cfg.static_assets.game_icon);
    let {w, restore} = (() => { let o = console.log, w = []; console.log = m => w.push(m); return {w, restore: () => { console.log = o; }}; })();
    let next;
    try {
        next = await generateManifest('wuwa_global', {existing: live, fetchState: () => fetchGameState(cfg, fakeHttp({version: '3.8.0', bg: null}))});
    } finally { restore(); }
    assert.strictEqual(next.game_versions[0].metadata.version, '3.8.0');
    assert.strictEqual(next.game_versions[0].assets.game_background, live.game_versions[0].assets.game_background);
    assert.ok(w.some(m => /background unavailable/.test(m)));
    let bare = buildVersionEntry(cfg, {version: '1.0.0', indexFile: 'i', zipBase: 'z', fullSize: 1, patches: [], assets: {}});
    assert.strictEqual(bare.assets.game_background, '');
});

test('append keeps older versions and is idempotent', async () => {
    let st = v => () => fetchGameState(cfg, fakeHttp({version: v}));
    let first = await generateManifest('wuwa_global', {existing: null, fetchState: st('3.7.0')});
    let second = await generateManifest('wuwa_global', {existing: first, fetchState: st('3.7.1')});
    assert.deepStrictEqual(second.game_versions.map(v => v.metadata.version), ['3.7.1', '3.7.0']);
    assert.strictEqual(second.latest_version, '3.7.1');
    assert.deepStrictEqual(await generateManifest('wuwa_global', {existing: second, fetchState: st('3.7.1')}), second);
    // up to date: only the small launcher index is read, none of the large index files
    let http = fakeHttp({version: '3.7.1'});
    let again = await generateManifest('wuwa_global', {existing: second, fetchState: () => fetchGameState(cfg, http, {known: new Set(['3.7.1', '3.7.0'])})});
    assert.deepStrictEqual(again, second);
    assert.strictEqual(http.calls.length, 1);
});

test('fail closed on unexpected launcher shapes and bad index files', async () => {
    assert.throws(() => normalizeLauncher({}, cfg), /no "default"/);
    assert.throws(() => normalizeLauncher({default: {}}, cfg), /empty cdnList/);
    assert.throws(() => normalizeLauncher({default: {cdnList: [{url: 'https://other.aki-game.net'}]}}, cfg), /preferred CDN/);
    assert.throws(() => normalizeLauncher({default: {cdnList: [{url: CDN}], config: {version: 'x.y'}}}, cfg), /invalid version/);
    assert.throws(() => normalizeLauncher({default: {cdnList: [{url: CDN}], config: {version: '1.0.0'}}}, cfg), /missing indexFile/);
    assert.throws(() => totalSize({resource: []}, 'idx'), /no "resource"/);
    assert.throws(() => totalSize({resource: [{dest: 'a', size: -1}]}, 'idx'), /malformed/);
    assert.throws(() => totalSize({resource: [{dest: 'a', size: '5'}]}, 'idx'), /malformed/);
    assert.throws(() => totalSize({resource: [{dest: 'a', size: 0}]}, 'idx'), /implausible/);
    let http = fakeHttp(); let orig = http.getJsonDigest;
    http.getJsonDigest = async (url, o) => { if (url.includes('/1.0.2/')) throw new Error('HTTP 503'); return orig(url, o); };
    await assert.rejects(generateManifest('wuwa_global', {existing: null, fetchState: () => fetchGameState(cfg, http)}), /HTTP 503/);
});

test('absUrl joins relative paths and leaves absolute URLs alone', () => {
    assert.strictEqual(absUrl('https://h.example/', '/a/b'), 'https://h.example/a/b');
    assert.strictEqual(absUrl('https://h.example', 'a/b'), 'https://h.example/a/b');
    assert.strictEqual(absUrl('https://h.example', 'https://x.example/a'), 'https://x.example/a');
});
