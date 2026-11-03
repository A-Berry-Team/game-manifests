// Gate between the generator scripts and the push to main. Every manifest from repository.json that
// differs from HEAD must still be a manifest and must keep every version HEAD had. Anything else is
// restored to HEAD so it can't be pushed, and listed in the "rejected" step output.
// Lives outside scripts/ because the workflow runs every scripts/*.js as a generator.
//
// Based on TwintailTeam/game-manifests PR #181, with three additions:
//   1. brand-new (untracked) manifests are validated too and deleted if rejected;
//   2. repository.json entries must be plain "<name>.json" file names;
//   3. every URL in a *new* version must point to an allowlisted vendor host, or be one of the exact reviewed
//      static URLs (supply-chain guard);
//   4. `extra.preload` (rewritten on every run) must be `{}` or a well-formed entry for a version newer than
//      latest_version, and ALL of its URLs must be allowlisted (it is not covered by the "new version" rule above).
const {readFileSync, appendFileSync, unlinkSync} = require('fs');
const {execFileSync} = require('child_process');
const {join} = require('path');

// Kept inline on purpose: the gate must not depend on code the generators can change (and the CLI test copies this
// file alone into a temporary repository). Same numeric dotted comparison as scripts/lib/versions.js.
function cmpVersion(a, b) {
    let pa = String(a).split('.').map(n => parseInt(n, 10) || 0), pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) { let d = (pa[i] || 0) - (pb[i] || 0); if (d !== 0) return d; }
    return 0;
}

const NAME_RE = /^[a-z0-9_]+\.json$/;

function hostOk(host, suffixes) {
    host = host.toLowerCase();
    return suffixes.some(s => host === s || host.endsWith('.' + s));
}

function collectUrls(node, out = []) {
    if (typeof node === 'string') { if (/^https?:\/\//i.test(node)) out.push(node); }
    else if (Array.isArray(node)) node.forEach(n => collectUrls(n, out));
    else if (node && typeof node === 'object') Object.values(node).forEach(n => collectUrls(n, out));
    return out;
}

function checkUrls(next, prev, suffixes, exactUrls = []) {
    let known = new Set(((prev && Array.isArray(prev.game_versions)) ? prev.game_versions : []).map(v => v?.metadata?.version));
    for (let v of next.game_versions) {
        if (known.has(v?.metadata?.version)) continue; // already accepted earlier
        for (let u of collectUrls(v)) {
            if (exactUrls.includes(u)) continue; // reviewed static URL from config (see static_asset_urls)
            let url;
            try { url = new URL(u); } catch { return `version ${v?.metadata?.version} has an invalid URL`; }
            if (url.protocol !== 'https:') return `version ${v?.metadata?.version} has a non-https URL (${url.origin})`;
            if (!hostOk(url.hostname, suffixes)) return `version ${v?.metadata?.version} references host not on the allowlist: ${url.hostname}`;
        }
    }
    return null;
}

function checkPreload(next, suffixes, exactUrls = []) {
    let pre = next.extra && next.extra.preload;
    if (pre === undefined) return null; // manifest without a preload slot (e.g. wuwa before it is implemented)
    if (!pre || typeof pre !== 'object' || Array.isArray(pre)) return 'extra.preload is not an object';
    if (Object.keys(pre).length === 0) return null; // no preload published
    let v = pre.metadata && pre.metadata.version;
    if (typeof v !== 'string' || !v) return 'extra.preload has no metadata.version';
    if (cmpVersion(v, next.latest_version) <= 0) return `extra.preload version ${v} is not newer than latest_version ${next.latest_version}`;
    if (!pre.game || !Array.isArray(pre.game.full) || pre.game.full.length === 0) return 'extra.preload has no game.full entries';
    if (suffixes) for (let u of collectUrls(pre)) {
        if (exactUrls.includes(u)) continue;
        let url;
        try { url = new URL(u); } catch { return 'extra.preload has an invalid URL'; }
        if (url.protocol !== 'https:') return `extra.preload has a non-https URL (${url.origin})`;
        if (!hostOk(url.hostname, suffixes)) return `extra.preload references host not on the allowlist: ${url.hostname}`;
    }
    return null;
}

function check(prevText, nextText, opts = {}) {
    if (nextText === null) return "is missing";
    let next;
    try { next = JSON.parse(nextText); } catch (e) { return `not valid JSON (${e.message})`; }
    if (!next || typeof next !== "object" || Array.isArray(next)) return `top level is ${String(nextText).trim().slice(0, 20)} instead of a manifest object`;
    if (!Array.isArray(next.game_versions) || next.game_versions.length === 0) return "game_versions is missing or empty";
    if (!next.latest_version) return "latest_version is missing";

    let prev = null;
    if (prevText !== null) { try { prev = JSON.parse(prevText); } catch { prev = null; } }

    if (opts.allowedHostSuffixes) {
        let bad = checkUrls(next, prev, opts.allowedHostSuffixes, opts.allowedUrls || []);
        if (bad) return bad;
    }

    let badPre = checkPreload(next, opts.allowedHostSuffixes, opts.allowedUrls || []);
    if (badPre) return badPre;

    if (prevText === null) return null; // new manifest, nothing to compare against
    if (!Array.isArray(prev?.game_versions)) return null; // HEAD itself was broken, any valid manifest is an improvement
    if (next.biz !== prev.biz) return `biz changed from ${prev.biz} to ${next.biz}`;

    let have = new Set(next.game_versions.map(v => v?.metadata?.version));
    let lost = prev.game_versions.map(v => v?.metadata?.version).filter(v => !have.has(v));
    if (lost.length > 0) return `would drop ${lost.length} existing version(s): ${lost.join(", ")}`;
    return null;
}

if (require.main === module) {
    const git = (...args) => execFileSync("git", args, {encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]});
    let manifests = JSON.parse(readFileSync("repository.json", "utf8")).manifests;
    let badNames = manifests.filter(m => !NAME_RE.test(m));
    if (badNames.length) {
        console.log(`::error file=repository.json::invalid manifest file name(s): ${badNames.join(", ")}`);
        process.exit(1);
    }
    let allow = JSON.parse(readFileSync(join(__dirname, "..", "..", "config", "allowed_hosts.json"), "utf8"));
    let suffixes = allow.output_host_suffixes, exactUrls = allow.static_asset_urls || [];

    let tracked = git("diff", "--name-only", "HEAD", "--", ...manifests).split("\n").filter(Boolean);
    let untracked = git("ls-files", "--others", "--exclude-standard", "--", ...manifests).split("\n").filter(Boolean);
    let changed = [...new Set([...tracked, ...untracked])];

    let rejected = [];
    for (let f of changed) {
        let prev = null, next = null;
        try { prev = git("show", `HEAD:${f}`); } catch {}
        try { next = readFileSync(f, "utf8"); } catch {}
        let problem = check(prev, next, {allowedHostSuffixes: suffixes, allowedUrls: exactUrls});
        if (problem === null) {
            console.log(`ok: ${f}`);
            continue;
        }
        if (prev === null) {
            console.log(`::error file=${f}::${f} ${problem}. Removed the new file instead.`);
            try { unlinkSync(f); } catch {}
        } else {
            console.log(`::error file=${f}::${f} ${problem}. Restored the committed version instead.`);
            git("checkout", "HEAD", "--", f);
        }
        rejected.push(f);
    }
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `rejected=${rejected.join(" ")}\n`);
}

module.exports = {check, checkUrls, checkPreload, collectUrls};
