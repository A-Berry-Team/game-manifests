const test = require('node:test');
const assert = require('node:assert');
const {check} = require('../.github/scripts/validate_manifests.js');

const ver = (v, url = 'https://autopatchhk.yuanshen.com/x') => ({metadata: {version: v}, game: {full: [{file_url: url}]}});
const mf = (versions, extra = {}) => JSON.stringify({biz: 'hk4e_global', latest_version: versions[0], game_versions: versions.map(v => ver(v)), ...extra});
const SUF = ['yuanshen.com', 'hoyoverse.com'];

test('rejects missing, null, invalid and non-object files', () => {
    assert.match(check(null, null), /missing/);
    assert.match(check(null, 'null'), /instead of a manifest/);
    assert.match(check(null, '{oops'), /not valid JSON/);
    assert.match(check(null, '[]'), /instead of a manifest/);
});
test('rejects empty game_versions and missing latest_version', () => {
    assert.match(check(null, JSON.stringify({biz: 'a', latest_version: '1', game_versions: []})), /empty/);
    assert.match(check(null, JSON.stringify({biz: 'a', game_versions: [ver('1')]})), /latest_version/);
});
test('rejects dropped versions (the sdsgc 2.99.0.0 incident)', () => {
    assert.match(check(mf(['2', '1']), mf(['2'])), /drop 1 existing version\(s\): 1/);
});
test('rejects biz changes', () => {
    assert.match(check(mf(['1']), mf(['1'], {biz: 'other'})), /biz changed/);
});
test('accepts additive updates and brand-new manifests', () => {
    assert.strictEqual(check(mf(['1']), mf(['2', '1'])), null);
    assert.strictEqual(check(null, mf(['1'])), null);
});
test('accepts a valid manifest when HEAD itself was broken', () => {
    assert.strictEqual(check('null', mf(['1'])), null);
});
test('URL allowlist applies to new versions only', () => {
    let evil = JSON.stringify({biz: 'a', latest_version: '2', game_versions: [ver('2', 'https://evil.example/x'), ver('1')]});
    assert.match(check(mf(['1']), evil, {allowedHostSuffixes: SUF}), /not on the allowlist: evil.example/);
    let http = JSON.stringify({biz: 'a', latest_version: '2', game_versions: [ver('2', 'http://autopatchhk.yuanshen.com/x')]});
    assert.match(check(null, http, {allowedHostSuffixes: SUF}), /non-https/);
    // an old, already accepted version with an unlisted host must not block updates
    let prev = JSON.stringify({biz: 'a', latest_version: '1', game_versions: [ver('1', 'https://legacy.example/x')]});
    let next = JSON.stringify({biz: 'a', latest_version: '2', game_versions: [ver('2'), ver('1', 'https://legacy.example/x')]});
    assert.strictEqual(check(prev, next, {allowedHostSuffixes: SUF}), null);
});
test('suffix matching is not fooled by look-alike hosts', () => {
    let fake = JSON.stringify({biz: 'a', latest_version: '1', game_versions: [ver('1', 'https://notyuanshen.com/x')]});
    assert.match(check(null, fake, {allowedHostSuffixes: SUF}), /not on the allowlist/);
});

test('exact static URLs are accepted even when their host is not allowlisted; nothing else on that host is', () => {
    const ICON = 'https://cdn2.steamgriddb.com/icon_thumb/abc.png';
    const withUrl = u => JSON.stringify({biz: 'wuwa_global', latest_version: '2', game_versions: [
        {metadata: {version: '2'}, assets: {game_icon: u}}, {metadata: {version: '1'}}]});
    const opts = {allowedHostSuffixes: SUF, allowedUrls: [ICON]};
    assert.strictEqual(check(null, withUrl(ICON), opts), null);
    assert.match(check(null, withUrl('https://cdn2.steamgriddb.com/icon_thumb/other.png'), opts), /not on the allowlist: cdn2\.steamgriddb\.com/);
    assert.match(check(null, withUrl(ICON), {allowedHostSuffixes: SUF}), /not on the allowlist/);
});

const PRE = (v, url = 'https://autopatchhk.yuanshen.com/p') => ({metadata: {version: v}, game: {full: [{file_url: url}]}});
test('extra.preload: {} and a well-formed newer preload are accepted; preload may appear and disappear', () => {
    assert.strictEqual(check(null, mf(['1'], {extra: {preload: {}}}), {allowedHostSuffixes: SUF}), null);
    assert.strictEqual(check(null, mf(['1'], {extra: {preload: PRE('2')}}), {allowedHostSuffixes: SUF}), null);
    assert.strictEqual(check(mf(['1'], {extra: {preload: PRE('2')}}), mf(['1'], {extra: {preload: {}}}), {allowedHostSuffixes: SUF}), null);
});
test('extra.preload: malformed, not-newer or empty preloads are rejected', () => {
    assert.match(check(null, mf(['2'], {extra: {preload: PRE('2')}})), /not newer/);
    assert.match(check(null, mf(['2'], {extra: {preload: PRE('1')}})), /not newer/);
    assert.match(check(null, mf(['1'], {extra: {preload: null}})), /not an object/);
    assert.match(check(null, mf(['1'], {extra: {preload: []}})), /not an object/);
    assert.match(check(null, mf(['1'], {extra: {preload: {game: {full: [{}]}}}})), /metadata\.version/);
    assert.match(check(null, mf(['1'], {extra: {preload: {metadata: {version: '2'}, game: {full: []}}}})), /game\.full/);
});
test('extra.preload: every URL must be on the allowlist, even when the version itself is not new', () => {
    let evil = mf(['1'], {extra: {preload: PRE('2', 'https://evil.example/p')}});
    assert.match(check(mf(['1']), evil, {allowedHostSuffixes: SUF}), /not on the allowlist: evil\.example/);
    assert.match(check(null, mf(['1'], {extra: {preload: PRE('2', 'http://autopatchhk.yuanshen.com/p')}}), {allowedHostSuffixes: SUF}), /non-https/);
});
