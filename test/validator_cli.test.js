// End-to-end check of the validator CLI inside a throw-away git repository.
const test = require('node:test');
const assert = require('node:assert');
const {mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, cpSync} = require('fs');
const {tmpdir} = require('os');
const {join, resolve} = require('path');
const {execFileSync, spawnSync} = require('child_process');

const ROOT = resolve(__dirname, '..');
const v = (ver) => ({metadata: {version: ver}, game: {full: [{file_url: 'https://autopatchhk.yuanshen.com/a'}]}});
const mf = (...vs) => JSON.stringify({biz: 'hk4e_global', latest_version: vs[0], game_versions: vs.map(v)}, null, 2);

test('CLI: restores broken files, deletes rejected new files, keeps good ones', () => {
    let dir = mkdtempSync(join(tmpdir(), 'val-'));
    let git = (...a) => execFileSync('git', a, {cwd: dir, stdio: 'ignore'});
    mkdirSync(join(dir, '.github/scripts'), {recursive: true});
    mkdirSync(join(dir, 'config'));
    cpSync(join(ROOT, '.github/scripts/validate_manifests.js'), join(dir, '.github/scripts/validate_manifests.js'));
    cpSync(join(ROOT, 'config/allowed_hosts.json'), join(dir, 'config/allowed_hosts.json'));
    writeFileSync(join(dir, 'repository.json'), JSON.stringify({manifests: ['good.json', 'null.json', 'drop.json', 'newbad.json', 'newgood.json']}));
    writeFileSync(join(dir, 'good.json'), mf('1'));
    writeFileSync(join(dir, 'null.json'), mf('1'));
    writeFileSync(join(dir, 'drop.json'), mf('2', '1'));
    git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
    git('add', '.'); git('commit', '-qm', 'init');

    writeFileSync(join(dir, 'good.json'), mf('2', '1'));      // valid update
    writeFileSync(join(dir, 'null.json'), 'null');            // the sdsgc "null" incident
    writeFileSync(join(dir, 'drop.json'), mf('3'));           // drops versions
    writeFileSync(join(dir, 'newbad.json'), 'null');          // new + broken
    writeFileSync(join(dir, 'newgood.json'), mf('1'));        // new + valid

    let out = join(dir, 'out.txt'); writeFileSync(out, '');
    let r = spawnSync('node', ['.github/scripts/validate_manifests.js'], {cwd: dir, env: {...process.env, GITHUB_OUTPUT: out}, encoding: 'utf8'});
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(readFileSync(join(dir, 'good.json'), 'utf8'), /"2"/);
    assert.strictEqual(readFileSync(join(dir, 'null.json'), 'utf8'), mf('1'));
    assert.strictEqual(readFileSync(join(dir, 'drop.json'), 'utf8'), mf('2', '1'));
    assert.ok(!existsSync(join(dir, 'newbad.json')));
    assert.ok(existsSync(join(dir, 'newgood.json')));
    let rejected = readFileSync(out, 'utf8').trim().replace('rejected=', '').split(' ').sort();
    assert.deepStrictEqual(rejected, ['drop.json', 'newbad.json', 'null.json']);
});

test('CLI: refuses path-like names in repository.json', () => {
    let dir = mkdtempSync(join(tmpdir(), 'val-'));
    mkdirSync(join(dir, '.github/scripts'), {recursive: true});
    mkdirSync(join(dir, 'config'));
    cpSync(join(ROOT, '.github/scripts/validate_manifests.js'), join(dir, '.github/scripts/validate_manifests.js'));
    cpSync(join(ROOT, 'config/allowed_hosts.json'), join(dir, 'config/allowed_hosts.json'));
    writeFileSync(join(dir, 'repository.json'), JSON.stringify({manifests: ['../evil.json']}));
    let r = spawnSync('node', ['.github/scripts/validate_manifests.js'], {cwd: dir, encoding: 'utf8'});
    assert.strictEqual(r.status, 1);
    assert.match(r.stdout, /invalid manifest file name/);
});
