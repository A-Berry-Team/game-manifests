// Numeric dotted-version comparison ("10.0.0" > "9.9.9"). Returns <0, 0, >0.
function cmpVersion(a, b) {
    let pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
    let pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        let d = (pa[i] || 0) - (pb[i] || 0);
        if (d !== 0) return d;
    }
    return 0;
}

module.exports = {cmpVersion};
