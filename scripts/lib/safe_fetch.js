'use strict';
// Hardened JSON-over-HTTPS client used by every generator.
//  - https only, no credentials in URL, host must be on the allowlist (also checked on every redirect hop)
//  - hard timeout, bounded retries with backoff for 429/5xx/network errors
//  - response size cap (16 MiB by default; callers that need more must ask for it explicitly)
//  - logs HTTP status on failure but NEVER the query string (Sophon URLs carry a "password" parameter)
const {readFileSync} = require('fs');
const {join} = require('path');
const {createHash} = require('crypto');

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const UA = 'org-game-manifests/1.0 (+automated manifest generator)';

function loadAllowedApiHosts() {
    return JSON.parse(readFileSync(join(__dirname, '..', '..', 'config', 'allowed_hosts.json'), 'utf8')).api_hosts;
}

function hostAllowed(host, allowed) {
    host = host.toLowerCase();
    return allowed.some(a => host === a || host.endsWith('.' + a));
}

function assertUrl(raw, allowedHosts) {
    let url;
    try { url = new URL(raw); } catch { throw fatal(new Error('invalid URL')); }
    if (url.protocol !== 'https:') throw fatal(new Error(`refusing non-https URL (${url.protocol})`));
    if (url.username || url.password) throw fatal(new Error('refusing URL with embedded credentials'));
    if (!hostAllowed(url.hostname, allowedHosts)) throw fatal(new Error(`host not on allowlist: ${url.hostname}`));
    return url;
}

function fatal(e) { e.fatal = true; return e; }
const redact = url => `${url.origin}${url.pathname}`;

async function readCapped(rsp, maxBytes) {
    let declared = Number(rsp.headers.get('content-length') || 0);
    if (declared > maxBytes) throw fatal(new Error(`response too large (${declared} bytes)`));
    let reader = rsp.body.getReader(), chunks = [], total = 0;
    for (;;) {
        let {done, value} = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) { await reader.cancel(); throw fatal(new Error(`response exceeded ${maxBytes} bytes`)); }
        chunks.push(value);
    }
    return Buffer.concat(chunks);
}

async function requestJson(rawUrl, opts = {}) {
    const {
        method = 'GET', headers = {}, body, allowedHosts = loadAllowedApiHosts(), timeoutMs = 20000, retries = 3,
        maxBytes = DEFAULT_MAX_BYTES, fetchImpl = globalThis.fetch, sleep = ms => new Promise(r => setTimeout(r, ms)),
        withDigest = false,
    } = opts;
    let first = assertUrl(rawUrl, allowedHosts), lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            let current = first, hops = 0, rsp;
            for (;;) {
                rsp = await fetchImpl(current.href, {
                    method, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
                    headers: {'user-agent': UA, accept: 'application/json', ...headers},
                });
                let loc = rsp.headers.get('location');
                if (rsp.status >= 300 && rsp.status < 400 && loc) {
                    if (method !== 'GET') throw fatal(new Error(`refusing to follow redirect for ${method}`));
                    if (++hops > 3) throw fatal(new Error('too many redirects'));
                    current = assertUrl(new URL(loc, current).href, allowedHosts);
                    continue;
                }
                break;
            }
            if (rsp.status === 429 || rsp.status >= 500) throw new Error(`HTTP ${rsp.status}`);
            if (rsp.status !== 200) throw fatal(new Error(`HTTP ${rsp.status}`));
            let buf = await readCapped(rsp, maxBytes);
            let json = JSON.parse(buf.toString('utf8'));
            // withDigest: also return the MD5 of the raw bytes. MD5 is only used to reproduce the content hash that the
            // vendor / reference manifests publish; it is not a security control.
            return withDigest ? {json, md5: createHash('md5').update(buf).digest('hex'), bytes: buf.length} : json;
        } catch (e) {
            lastErr = e;
            if (e.fatal || attempt === retries) break;
            await sleep(500 * 2 ** attempt);
        }
    }
    let msg = `${method} ${redact(first)} failed: ${lastErr.message}`;
    console.error(msg);
    throw new Error(msg);
}

module.exports = {
    getJson: (url, opts) => requestJson(url, {...opts, method: 'GET'}),
    // GET + {json, md5, bytes}; for large vendor index files (use a bigger maxBytes / timeoutMs explicitly)
    getJsonDigest: (url, opts) => requestJson(url, {...opts, method: 'GET', withDigest: true}),
    postJson: (url, payload, opts) => requestJson(url, {
        ...opts, method: 'POST', body: JSON.stringify(payload), headers: {'content-type': 'application/json', ...(opts && opts.headers)},
    }),
    requestJson, assertUrl, hostAllowed,
};
