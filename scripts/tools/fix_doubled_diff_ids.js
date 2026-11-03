'use strict';
// One-off repair for manifests produced before the "doubled category id" fix.
//
// Sophon's `diff_download.url_prefix` already ends with the category id (".../diffs/<branch>/<patch>/10016").
// Early versions of the generator appended the id a second time (".../10016/10016"), which made every diff
// `file_path` and `metadata.diff_list_url.*` of the affected versions point to a non-existent location.
// Because the generator only ever ADDS versions, those old entries would stay broken forever; this tool fixes them.
//
//   node scripts/tools/fix_doubled_diff_ids.js [--write] <manifest.json>...
//
// Without --write it only reports. It touches nothing but URLs ending in "/<id>/<id>" (same numeric id twice) inside
// `file_path` / `diff_list_url` fields of diff entries, and prints a count per file.
const {readFileSync, writeFileSync} = require('fs');

const DOUBLED = /^(https:\/\/.+)\/(\d+)\/\2$/;
const fixUrl = u => (typeof u === 'string' && DOUBLED.test(u)) ? u.replace(DOUBLED, '$1/$2') : u;

function fixManifest(manifest) {
    let fixed = 0;
    let fixDiffs = list => { for (let d of list || []) { let n = fixUrl(d.file_path); if (n !== d.file_path) { d.file_path = n; fixed++; } } };
    let fixMeta = md => { for (let [k, u] of Object.entries((md && md.diff_list_url) || {})) { let n = fixUrl(u); if (n !== u) { md.diff_list_url[k] = n; fixed++; } } };
    let fixEntry = e => { if (!e) return; fixMeta(e.metadata); fixDiffs(e.game && e.game.diff); fixDiffs(e.audio && e.audio.diff); };
    for (let v of manifest.game_versions || []) fixEntry(v);
    if (manifest.extra && manifest.extra.preload) fixEntry(manifest.extra.preload);
    return fixed;
}

if (require.main === module) {
    let args = process.argv.slice(2), write = args.includes('--write'), files = args.filter(a => a !== '--write');
    if (!files.length) { console.error('usage: fix_doubled_diff_ids.js [--write] <manifest.json>...'); process.exit(2); }
    for (let f of files) {
        let m = JSON.parse(readFileSync(f, 'utf8')), n = fixManifest(m);
        console.log(`${f}: ${n} doubled id(s) ${write ? 'fixed' : 'found'}`);
        if (write && n > 0) writeFileSync(f, JSON.stringify(m, null, 2), 'utf8');
    }
}

module.exports = {fixManifest, fixUrl};
