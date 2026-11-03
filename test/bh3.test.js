// NOTE: raw API payloads are ASSUMED shapes (see scripts/lib/hoyo_sophon.js). These tests prove the multi-region
// pipeline produces output structurally identical to the published bh3_global.json (test/fixtures/bh3_reference.json,
// taken from the first lines of that file) and that its safety rules hold. They do not prove the live API matches.
const test = require('node:test');
const assert = require('node:assert');
const {readFileSync} = require('fs');
const {join} = require('path');
const {fetchRegionalState} = require('../scripts/lib/hoyo_sophon');
const {generateManifest} = require('../scripts/hoyo_manifests');
const {signature, diffSignatures} = require('../scripts/tools/compare_schema');

const GAMES = require('../config/games.json');
const cfg = GAMES.bh3_global;
const ref = JSON.parse(readFileSync(join(__dirname, 'fixtures/bh3_reference.json'), 'utf8'));
const CATS = {big: 1, small: 2};
const ID_OF = {bh3_global: '5TIVvvcwtM', bh3_jp: 'g0mMIvshDb', bh3_kr: 'uxB4MC7nzC', bh3_os: 'bxPTXSET5t', bh3_asia: 'wkE5P5WsIf'}; // real HoYoPlay ids
const HOST = {bh3_global: 'autopatchglb', bh3_jp: 'autopatchjp', bh3_kr: 'autopatchkr', bh3_os: 'autopatchos', bh3_asia: 'autopatchasia'};

// opts.tags: biz -> tag; opts.missing: [biz]; opts.failBuild: [biz]
function fakeHttp({tags = {}, missing = [], failBuild = [], pre = null, preTags = {}} = {}) {
    let bizs = Object.keys(HOST).filter(b => !missing.includes(b));
    let idOf = b => ID_OF[b], bizOf = id => Object.keys(ID_OF).find(k => ID_OF[k] === id);
    return {
        async getJson(url) {
            // all regions share the biz "bh3_global" and differ by id, like the real API
            if (url.includes('getGames?')) return {retcode: 0, data: {games: bizs.map(b => ({id: idOf(b), biz: 'bh3_global', display: {icon: {url: 'https://fastcdn.hoyoverse.com/icon.png'}}}))}};
            if (url.includes('getGameBranches')) {
                let id = decodeURIComponent(/game_ids\[\]=([^&]+)/.exec(url)[1]), b = bizOf(id);
                if (missing.includes(b)) return {retcode: 0, data: {game_branches: []}};
                return {retcode: 0, data: {game_branches: [{game: {id}, main: {
                    package_id: `P_${b}`, branch: 'B', password: `PW_${b}`, tag: tags[b] || '9.1.0', diff_tags: [],
                    categories: [{category_id: '1', matching_field: 'game'}, {category_id: '2', matching_field: 'res'}],
                }, pre_download: pre && {
                    package_id: `PP_${b}`, branch: 'PB', password: `PPW_${b}`, tag: preTags[b] || pre, diff_tags: [],
                    categories: [{category_id: '1', matching_field: 'game'}, {category_id: '2', matching_field: 'res'}],
                }}]}};
            }
            if (url.includes('getAllGameBasicInfo')) return {retcode: 0, data: {game_info_list: [{game: {id: ID_OF.bh3_global},
                backgrounds: [{type: 'BACKGROUND_TYPE_VIDEO', background: {url: 'https://launcher-webstatic.hoyoverse.com/b.webp'}, video: {url: 'https://launcher-webstatic.hoyoverse.com/l.webm'}, theme: {url: 'https://launcher-webstatic.hoyoverse.com/theme.webp'}}]}]}};
            if (url.includes('getBuild')) {
                let isPre = url.includes('branch=PB');
                let b = decodeURIComponent(/package_id=([^&]+)/.exec(url)[1]).replace(/^PP?_/, '');
                if (failBuild.includes(b)) return {retcode: -1, message: 'boom'};
                let cdn = `https://${HOST[b]}.honkaiimpact3.com/ptpublic/rel/chunk`;
                // deliberately returned small-first to prove the generator sorts biggest-first
                return {retcode: 0, data: {tag: isPre ? (preTags[b] || pre) : '9.1.0', manifests: [['small', 2, 900], ['big', 1, 30000]].map(([k, id, size]) => ({
                    category_id: id, manifest: {id: `manifest_aa_${b}${k}`, checksum: `${b}${k}`},
                    manifest_download: {url_prefix: `${cdn}/manifests/${isPre ? 'pre' : 'pkg'}/${b}`}, chunk_download: {url_prefix: `${cdn}/chunks/${isPre ? 'pre' : 'pkg'}/${b}`},
                    stats: {compressed_size: size - 10, uncompressed_size: size},
                }))}};
            }
            throw new Error('unexpected ' + url);
        },
        async postJson() { throw new Error('bh3 must not request patches'); },
    };
}

const quietWarn = () => { let w = []; return {w, warn: m => w.push(m)}; };

test('regional state: all regions, primary version and assets', async () => {
    let s = await fetchRegionalState(cfg, fakeHttp(), () => {});
    assert.strictEqual(s.version, '9.1.0');
    assert.deepStrictEqual(s.regions.map(r => r.region_code), cfg.regions.map(r => r.region_code));
    assert.deepStrictEqual(cfg.regions.map(r => r.game_id), Object.values(ID_OF));
    assert.match(s.assets.game_background, /b\.webp$/);
    assert.match(s.assets.game_live_background, /l\.webm$/); // video, not theme
    assert.match(s.assets.game_icon, /icon\.png$/);        // from getGames
});

test('generated bh3 manifest has the same structure as the published one', async () => {
    let m = await generateManifest('bh3_global', {existing: null, fetchState: () => fetchRegionalState(cfg, fakeHttp(), () => {})});
    assert.deepStrictEqual(diffSignatures(signature(ref), signature(m)), []);
    let e = m.game_versions[0];
    assert.strictEqual(m.display_name, 'HonkaiImpact 3rd (Global)');
    assert.strictEqual(e.metadata.versioned_name, 'HonkaiImpact 3rd 9.1.0 (Global)');
    assert.strictEqual(e.metadata.res_list_url, e.game.full[0].file_path);
    assert.deepStrictEqual(e.game.diff, []);
    assert.deepStrictEqual(e.audio, {full: [], diff: []});
    assert.strictEqual(e.game.full.length, cfg.regions.length * 2);
    // per region: biggest manifest first, region order as in config
    assert.deepStrictEqual(e.game.full.slice(0, 4).map(f => `${f.region_code}:${f.decompressed_size}`),
        ['glb_official:30000', 'glb_official:900', 'jp_official:30000', 'jp_official:900']);
    assert.ok(e.game.full.every(f => typeof f.compressed_size === 'string' && f.file_path.includes('/chunks/')));
});

test('optional region that is missing, broken or on another version is skipped with a warning', async () => {
    for (let opts of [{missing: ['bh3_kr']}, {failBuild: ['bh3_kr']}, {tags: {bh3_kr: '9.0.0'}}]) {
        let {w, warn} = quietWarn();
        let s = await fetchRegionalState(cfg, fakeHttp(opts), warn);
        assert.ok(!s.regions.some(r => r.region_code === 'kr_official'), JSON.stringify(opts));
        assert.strictEqual(s.regions.length, 4);
        assert.strictEqual(w.length, 1);
        assert.match(w[0], /kr_official/);
    }
});

test('required (primary) region failure fails the whole run', async () => {
    await assert.rejects(fetchRegionalState(cfg, fakeHttp({missing: ['bh3_global']}), () => {}), /required region glb_official/);
    await assert.rejects(fetchRegionalState(cfg, fakeHttp({failBuild: ['bh3_global']}), () => {}), /required region glb_official.*retcode=-1/);
});

test('bh3 append keeps older versions and is idempotent', async () => {
    let st = tag => () => fetchRegionalState(cfg, fakeHttp({tags: Object.fromEntries(Object.keys(HOST).map(b => [b, tag]))}), () => {});
    let first = await generateManifest('bh3_global', {existing: null, fetchState: st('9.0.0')});
    let second = await generateManifest('bh3_global', {existing: first, fetchState: st('9.1.0')});
    assert.deepStrictEqual(second.game_versions.map(v => v.metadata.version), ['9.1.0', '9.0.0']);
    assert.strictEqual(second.latest_version, '9.1.0');
    assert.deepStrictEqual(await generateManifest('bh3_global', {existing: second, fetchState: st('9.1.0')}), second);
});

test('preload: multi-region preload lists every region, biggest first, with region codes; none -> {}', async () => {
    let none = await generateManifest('bh3_global', {existing: null, fetchState: () => fetchRegionalState(cfg, fakeHttp(), () => {})});
    assert.deepStrictEqual(none.extra, {preload: {}});
    let m = await generateManifest('bh3_global', {existing: null, fetchState: () => fetchRegionalState(cfg, fakeHttp({pre: '9.2.0'}), () => {})});
    let p = m.extra.preload;
    assert.strictEqual(p.metadata.versioned_name, 'HonkaiImpact 3rd 9.2.0 Preload (Global)');
    assert.strictEqual(p.metadata.res_list_url, p.game.full[0].file_path);
    assert.ok(p.game.full[0].file_path.includes('/chunks/pre/'));
    assert.strictEqual(p.game.full.length, cfg.regions.length * 2);
    assert.deepStrictEqual(p.game.full.slice(0, 4).map(f => `${f.region_code}:${f.decompressed_size}`),
        ['glb_official:30000', 'glb_official:900', 'jp_official:30000', 'jp_official:900']);
    assert.deepStrictEqual(p.game.diff, []);
    assert.deepStrictEqual(p.audio, {full: [], diff: []});
    assert.deepStrictEqual(m.game_versions.map(v => v.metadata.version), ['9.1.0']);
    assert.deepStrictEqual(diffSignatures(signature(JSON.parse(JSON.stringify({extra: {preload: p}}))), signature({extra: {preload: p}})), []);
});

test('preload: a region whose preload tag differs from the primary one is left out with a warning', async () => {
    let {w, warn} = quietWarn();
    let m = await generateManifest('bh3_global', {existing: null, warn, fetchState: () => fetchRegionalState(cfg, fakeHttp({pre: '9.2.0', preTags: {bh3_kr: '9.2.1'}}), () => {})});
    assert.ok(!m.extra.preload.game.full.some(f => f.region_code === 'kr_official'));
    assert.ok(w.some(x => /kr_official/.test(x)));
});
