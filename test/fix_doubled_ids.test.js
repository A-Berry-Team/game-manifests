const test = require('node:test');
const assert = require('node:assert');
const {fixManifest, fixUrl} = require('../scripts/tools/fix_doubled_diff_ids');

test('only "/<id>/<id>" suffixes are collapsed', () => {
    assert.strictEqual(fixUrl('https://a.yuanshen.com/diffs/x/y/10016/10016'), 'https://a.yuanshen.com/diffs/x/y/10016');
    assert.strictEqual(fixUrl('https://a.yuanshen.com/diffs/x/y/10016'), 'https://a.yuanshen.com/diffs/x/y/10016');
    assert.strictEqual(fixUrl('https://a.yuanshen.com/diffs/x/10016/10017'), 'https://a.yuanshen.com/diffs/x/10016/10017');
    assert.strictEqual(fixUrl(''), '');
});

test('fixes diff paths, diff_list_url and the preload; leaves chunk paths alone', () => {
    let d = 'https://a.yuanshen.com/diffs/x/y/10016';
    let e = () => ({metadata: {diff_list_url: {game: `${d}/10016`, en_us: ''}}, game: {full: [{file_path: 'https://a.yuanshen.com/chunks/1/2'}], diff: [{file_path: `${d}/10016`}]}, audio: {full: [], diff: [{file_path: d}]}});
    let m = {game_versions: [e()], extra: {preload: e()}};
    assert.strictEqual(fixManifest(m), 4);
    assert.strictEqual(m.game_versions[0].game.diff[0].file_path, d);
    assert.strictEqual(m.extra.preload.metadata.diff_list_url.game, d);
    assert.strictEqual(m.game_versions[0].game.full[0].file_path, 'https://a.yuanshen.com/chunks/1/2');
    assert.strictEqual(fixManifest(m), 0);
});
