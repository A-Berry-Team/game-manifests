const test = require('node:test');
const assert = require('node:assert');
const {signature, diffSignatures} = require('../scripts/tools/compare_schema');

test('detects missing, unexpected and mistyped paths; ignores values and array length', () => {
    let ref = signature({a: 1, b: [{c: 'x'}]});
    assert.deepStrictEqual(diffSignatures(ref, signature({a: 9, b: [{c: 'y'}, {c: 'z'}]})), []);
    assert.deepStrictEqual(diffSignatures(ref, signature({a: 1, b: [{}]})), ['missing path $.b[].c']);
    assert.deepStrictEqual(diffSignatures(ref, signature({a: '1', b: [{c: 'x'}]})), ['type mismatch at $.a: number vs string']);
    assert.deepStrictEqual(diffSignatures(ref, signature({a: 1, b: [{c: 'x'}], d: 1})), ['unexpected path $.d']);
});
