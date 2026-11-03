// Structural comparison of two manifests: same key paths and same value types, ignoring values and
// array lengths. Use it to prove a generated manifest has the same structure as a reference one.
//   node scripts/tools/compare_schema.js <reference.json> <candidate.json>
const {readFileSync} = require('fs');

function typeOf(v) { return v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v; }

function signature(node, path = '$', out = new Map()) {
    let t = typeOf(node);
    if (!out.has(path)) out.set(path, new Set());
    out.get(path).add(t);
    if (t === 'array') node.forEach(n => signature(n, path + '[]', out));
    else if (t === 'object') for (let [k, v] of Object.entries(node)) signature(v, `${path}.${k}`, out);
    return out;
}

function diffSignatures(ref, cand) {
    let problems = [];
    for (let [p, types] of ref) {
        if (!cand.has(p)) { problems.push(`missing path ${p}`); continue; }
        for (let t of cand.get(p)) if (!types.has(t)) problems.push(`type mismatch at ${p}: ${[...types]} vs ${t}`);
    }
    for (let p of cand.keys()) if (!ref.has(p)) problems.push(`unexpected path ${p}`);
    return problems;
}

if (require.main === module) {
    let [a, b] = process.argv.slice(2);
    if (!a || !b) { console.error('usage: compare_schema.js <reference.json> <candidate.json>'); process.exit(2); }
    let problems = diffSignatures(signature(JSON.parse(readFileSync(a, 'utf8'))), signature(JSON.parse(readFileSync(b, 'utf8'))));
    if (problems.length) { console.log(problems.join('\n')); process.exit(1); }
    console.log('structures match');
}

module.exports = {signature, diffSignatures};
