// Guards against configuration drift: the pieces that must agree with each other are checked together.
const test = require('node:test');
const assert = require('node:assert');
const GAMES = require('../config/games.json');
const HOSTS = require('../config/allowed_hosts.json');
const REPO = require('../repository.json');
const {hostAllowed} = require('../scripts/lib/safe_fetch');

const IN_SCOPE = ['hk4e_global', 'hkrpg_global', 'nap_global', 'bh3_global', 'wuwa_global'];

test('exactly the five requested games are configured, all implemented and all published', () => {
    assert.deepStrictEqual(Object.keys(GAMES).sort(), [...IN_SCOPE].sort());
    for (let [biz, cfg] of Object.entries(GAMES)) {
        assert.strictEqual(cfg.status, 'implemented', biz);
        assert.strictEqual(cfg.file, `${biz}.json`);
        assert.ok(REPO.manifests.includes(cfg.file), `${cfg.file} missing from repository.json`);
    }
    assert.deepStrictEqual([...REPO.manifests].sort(), IN_SCOPE.map(b => `${b}.json`).sort());
});

test('every static asset URL in games.json is either on an allowlisted host or an exact static_asset_urls entry', () => {
    for (let [biz, cfg] of Object.entries(GAMES)) {
        for (let [k, u] of Object.entries(cfg.static_assets || {})) {
            if (!u) continue;
            let url = new URL(u);
            assert.ok(url.protocol === 'https:', `${biz}.${k}`);
            assert.ok(HOSTS.static_asset_urls.includes(u) || hostAllowed(url.hostname, HOSTS.output_host_suffixes), `${biz}.${k} would be rejected by the validator`);
        }
    }
    for (let u of HOSTS.static_asset_urls) assert.strictEqual(new URL(u).protocol, 'https:');
});

test('kuro endpoints in config are on the API allowlist', () => {
    let cfg = GAMES.wuwa_global;
    for (let u of [cfg.launcher_base_url, cfg.launcher_background_base, `https://${cfg.cdn_preferred_host}/`]) {
        assert.ok(hostAllowed(new URL(u).hostname, HOSTS.api_hosts), u);
    }
    assert.strictEqual(
        `${cfg.launcher_base_url}/${cfg.launcher_index_path}`,
        'https://prod-alicdn-gamestarter.kurogame.com/launcher/game/G153/50004_obOHXFrFanqsaIEOmuKroCcbZkQRBC7c/index.json'
    );
    assert.ok(cfg.launcher_background_base.includes('/50004_obOHXFrFanqsaIEOmuKroCcbZkQRBC7c/G153/background'));
});

test('multi-region config: one required primary region first, unique region codes and game ids', () => {
    let r = GAMES.bh3_global.regions;
    assert.strictEqual(r[0].required, true);
    assert.strictEqual(r[0].region_code, 'glb_official');
    assert.strictEqual(new Set(r.map(x => x.region_code)).size, r.length);
    assert.strictEqual(new Set(r.map(x => x.game_id)).size, r.length);
    assert.ok(r.every(x => /^[A-Za-z0-9]{10}$/.test(x.game_id) && x.biz === 'bh3_global'));
});
