const test = require('node:test');
const assert = require('node:assert');
const {mkdtempSync, writeFileSync, readFileSync} = require('fs');
const {tmpdir} = require('os');
const {join} = require('path');
const {saveManifest} = require('../scripts/lib/save_manifest');

async function run(pending, initial = 'KEEP') {
    let p = join(mkdtempSync(join(tmpdir(), 'sm-')), 'm.json');
    writeFileSync(p, initial);
    let before = process.exitCode;
    process.exitCode = 0;
    let origErr = console.error; console.error = () => {};
    await saveManifest(p, pending);
    console.error = origErr;
    let code = process.exitCode; process.exitCode = before;
    return {text: readFileSync(p, 'utf8'), code};
}
const good = {biz: 'x', game_versions: [{metadata: {version: '1'}}]};

test('refuses null / empty / failed results and keeps the file', async () => {
    for (let bad of [Promise.resolve(null), Promise.resolve({}), Promise.resolve({biz: 'x', game_versions: []}), Promise.reject(new Error('boom'))]) {
        let r = await run(bad);
        assert.strictEqual(r.text, 'KEEP');
        assert.strictEqual(r.code, 1);
    }
});
test('writes a valid manifest', async () => {
    let r = await run(Promise.resolve(good));
    assert.deepStrictEqual(JSON.parse(r.text), good);
    assert.strictEqual(r.code, 0);
});
