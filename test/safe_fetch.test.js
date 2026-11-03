const test = require('node:test');
const assert = require('node:assert');
const {requestJson, assertUrl, hostAllowed} = require('../scripts/lib/safe_fetch');

const ALLOWED = ['api.example.com'];
const quiet = fn => async (...a) => { let o = console.error; console.error = () => {}; try { return await fn(...a); } finally { console.error = o; } };
const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), {status, headers});

test('URL policy', () => {
    assert.throws(() => assertUrl('http://api.example.com/x', ALLOWED), /non-https/);
    assert.throws(() => assertUrl('https://evil.com/x', ALLOWED), /allowlist/);
    assert.throws(() => assertUrl('https://api.example.com.evil.com/x', ALLOWED), /allowlist/);
    assert.throws(() => assertUrl('https://u:p@api.example.com/x', ALLOWED), /credentials/);
    assert.throws(() => assertUrl('nonsense', ALLOWED), /invalid URL/);
    assert.ok(assertUrl('https://sub.api.example.com/x', ALLOWED));
    assert.ok(hostAllowed('API.example.com', ALLOWED));
});

test('retries 5xx then succeeds', async () => {
    let calls = 0;
    let fetchImpl = async () => (++calls < 3 ? json({}, 503) : json({ok: true}));
    let r = await requestJson('https://api.example.com/x', {allowedHosts: ALLOWED, fetchImpl, sleep: async () => {}});
    assert.deepStrictEqual(r, {ok: true});
    assert.strictEqual(calls, 3);
});

test('does not retry 4xx and never logs the query string', quiet(async () => {
    let calls = 0, logged = [];
    let fetchImpl = async () => { calls++; return json({}, 404); };
    let orig = console.error; console.error = m => logged.push(m);
    await assert.rejects(requestJson('https://api.example.com/x?password=SECRET', {allowedHosts: ALLOWED, fetchImpl, sleep: async () => {}}), e => {
        assert.ok(!e.message.includes('SECRET')); return /HTTP 404/.test(e.message);
    });
    console.error = orig;
    assert.strictEqual(calls, 1);
    assert.ok(logged.every(m => !m.includes('SECRET')));
}));

test('redirects must stay on the allowlist', quiet(async () => {
    let fetchImpl = async () => new Response(null, {status: 302, headers: {location: 'https://evil.com/steal'}});
    await assert.rejects(requestJson('https://api.example.com/x', {allowedHosts: ALLOWED, fetchImpl, sleep: async () => {}}), /allowlist/);
}));

test('enforces response size cap', quiet(async () => {
    let fetchImpl = async () => json({blob: 'x'.repeat(5000)});
    await assert.rejects(requestJson('https://api.example.com/x', {allowedHosts: ALLOWED, fetchImpl, maxBytes: 1000, sleep: async () => {}}), /too large|exceeded/);
}));

test('getJsonDigest returns the parsed JSON, the MD5 of the raw bytes and the size; honours a raised size cap', async () => {
    const {getJsonDigest} = require('../scripts/lib/safe_fetch');
    const body = '{"resource":[{"dest":"a","md5":"x","size":1}]}';
    const fetchImpl = async () => new Response(body, {status: 200});
    let r = await getJsonDigest('https://api.example.com/i.json', {allowedHosts: ALLOWED, fetchImpl});
    assert.deepStrictEqual(r.json, JSON.parse(body));
    assert.strictEqual(r.md5, require('crypto').createHash('md5').update(body).digest('hex'));
    assert.strictEqual(r.bytes, Buffer.byteLength(body));
    // default 16 MiB cap still applies unless the caller asks for more
    let big = async () => new Response('{"x":"' + 'a'.repeat(1024) + '"}', {status: 200, headers: {'content-length': String(20 * 1024 * 1024)}});
    let origErr = console.error; console.error = () => {};
    try { await assert.rejects(getJsonDigest('https://api.example.com/i.json', {allowedHosts: ALLOWED, fetchImpl: big}), /too large/); }
    finally { console.error = origErr; }
    let ok = await getJsonDigest('https://api.example.com/i.json', {allowedHosts: ALLOWED, fetchImpl: big, maxBytes: 64 * 1024 * 1024});
    assert.ok(ok.json.x);
});
