#version 330 core
// Infinite rotating habitat tube, raymarched. Everything is procedural.
// Space: xy is the tube cross-section, z is the axis. z is camera-relative;
// the periodic offsets in uB put it back into station / ship coordinates.
out vec4 O;
uniform vec4 uA; // xy resolution, z time (wrapped at 2000*pi), w hue phase
uniform vec4 uB; // x station z offset, y ship z offset, z station spin angle, w fog z offset
uniform vec4 uC; // xyz camera position (z = 0), w +1 or -1: which way along the tube is ahead
uniform vec4 uD; // w traffic phase (wrapped at 1024)
uniform vec4 uE; // xy sub-pixel jitter for temporal anti-aliasing, z pixel aspect (< 0: 180-degree lens), w lens shift (stereo)
uniform mat3 uM; // camera basis: right, up, forward
uniform sampler3D uN; // tiling cloud noise

#define PI 3.14159265
#define TAU 6.2831853
const float R = 100.;   // tube radius
const float ZP = 6144.; // station z period (every cell size divides it)
const float RP = 96.;   // ring spacing: 80 of city, 16 of open space
const float SP = 800.;  // ship slot spacing
const float FAR = 850.;
const float SS = 1.25;   // ship scale
const float NS = 800., CS = .8;  // city cells: count around, length along z
const float NB = 40., CB = 16.;  // district cells (20x20 city cells)

float gSafe; // max safe step (domain repetition bound)
float gMat;  // 0 station, 1 ship
float gT;    // ray distance of the current sample, for LOD
float gLod;  // shadow rays: 1 skips ship detail, 2 also skips the small buildings
vec4 gL;     // distance to: warm lamp, ship running light, ion exhaust, reactor ring
vec4 gS;     // ship surface tags: nozzle interior, reactor ring, docking bay, container hash
float gH;    // surface relief from the last rust() call, for bump mapping

float h21(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * .1031);
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
}
vec3 h23(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973));
    q += dot(q, q.yxz + 33.33);
    return fract((q.xxy + q.yzz) * q.zyx);
}
vec2 rot(vec2 p, float a) {
    float c = cos(a), s = sin(a);
    return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}
float sdB(vec3 e) { return min(max(e.x, max(e.y, e.z)), 0.) + length(max(e, 0.)); }
float sdB2(vec2 e) { return min(max(e.x, e.y), 0.) + length(max(e, 0.)); }

// 2D value noise on a wrapped lattice
float n2(vec2 p, vec2 per) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * f * (f * (f * 6. - 15.) + 10.);
    vec2 a = mod(i, per), b = mod(i + 1., per);
    return mix(mix(h21(a), h21(vec2(b.x, a.y)), f.x), mix(h21(vec2(a.x, b.y)), h21(b), f.x), f.y);
}
// fbm in surface units; octaves fade to their mean once they fall below the pixel footprint px
float fbm(vec2 p, vec2 sc, float px, int oct) {
    float s = 0., a = .5;
    for (int i = 0; i < oct; i++) {
        float w = a * clamp(1.5 - 2.5 * max(sc.x, sc.y) * px, 0., 1.);
        s += w * n2(p * sc, ZP * sc) + (a - w) * .5;
        sc *= 2.;
        a *= .5;
    }
    return s / (1. - a * 2.);
}
// Corroded steel: bare metal, rust blooms, drip streaks and pitting. bias shifts how much has rusted.
vec3 rust(vec2 uv, float px, float bias, out float rough) {
    // warp the domain first so no patch edge lines up with the noise lattice
    uv += 5. * (vec2(n2(uv * .125, vec2(ZP * .125)), n2(uv * .125 + 9.5, vec2(ZP * .125))) - .5);
    uv += .6 * (vec2(n2(uv * 2., vec2(ZP * 2.)), n2(uv * 2. + 4.5, vec2(ZP * 2.))) - .5);
    float big = fbm(uv, vec2(.25), px, 3);
    float med = fbm(uv + 31., vec2(2.), px, 2);
    float drip = fbm(uv + 77., vec2(4., .5), px, 2);
    float pit = fbm(uv + 13., vec2(16.), px, 2);
    float r = smoothstep(.40, .64, big * .55 + med * .3 + drip * .35 - .1 + bias);
    r = max(r, .8 * smoothstep(.60, .78, drip + bias));
    vec3 steel = vec3(.060, .066, .072) * (.5 + med);
    vec3 ox = mix(vec3(.15, .062, .028), vec3(.055, .028, .018), smoothstep(.3, .7, pit));
    rough = mix(.28 + .25 * med, .95, r);
    gH = med * .5 + pit * .35 - r * .25; // rust eats into the plate
    return mix(steel, ox, r) * (.75 + .5 * pit);
}

// blue -> purple -> red -> green -> yellow -> blue
vec3 pal(float x) {
    const vec3 K[6] = vec3[6](
        vec3(.07, .40, .62), vec3(.34, .16, .64), vec3(.66, .14, .11),
        vec3(.11, .55, .27), vec3(.68, .52, .12), vec3(.07, .40, .62));
    x = fract(x) * 5.;
    int i = min(int(x), 4);
    return mix(K[i], K[i + 1], smoothstep(0., 1., fract(x)));
}

// ---------------------------------------------------------------- ships
// Ships live in slots of length SP. Local frame: nose at -z, tail at +z, units of SS.
void shipSlot(float id, out vec3 rn, out float L, out float roll) {
    rn = h23(vec2(mod(id, 64.), 7.));
    L = 70. + 50. * rn.x;
    roll = (rn.z - .5) * 1.2;
}
vec3 shipQ(vec3 p, out vec3 rn, out float L) {
    float zs = p.z + uB.y, id = floor(zs / SP), roll;
    shipSlot(id, rn, L, roll);
    vec3 q = vec3(p.xy - (rn.yz - .5) * vec2(16., 8.), zs - (id + .5) * SP) / SS;
    q.xy = rot(q.xy, roll);
    return q;
}
float taper(float tz) { return (1. - .6 * smoothstep(-.35, -1., tz)) * (1. - .2 * smoothstep(.7, 1., tz)); }
float pulse(float z) {
    float s = .5 + .5 * sin(uA.z * 1.8 - z * .12);
    return .2 + .8 * s * s;
}

// Smooth random walk in time: a new random value every 16 s, eased between (wraps with uD.w).
float wander(float seed) {
    float x = uD.w / 16. + seed * 64., i = floor(x), f = fract(x);
    f = f * f * (3. - 2. * f);
    return mix(h21(vec2(mod(i, 64.), seed)), h21(vec2(mod(i + 1., 64.), seed)), f) - .5;
}

// Searchlight k (station along the hull) on side s: origin and direction in the ship frame.
// Each one slowly hunts around: up and down the hull side, fore and aft.
float beamRay(float k, float s, vec3 rn, float L, out vec3 o, out vec3 u) {
    float zk = (k + .5) * 30.;
    float hh = h21(vec2(k * 2. + s, rn.x * 91. + 3.));
    if (hh < .4 || abs(zk) > .8 * L) return 0.;
    float a = wander(hh) * 2.6, b = wander(hh + .37) * 1.3;
    o = vec3(s * (7. * taper(zk / L) + .9), 0., zk);
    u = vec3(s * cos(a) * cos(b), sin(a) * cos(b), sin(b));
    return 1.;
}

float ships(vec3 p) {
    vec3 rn; float L;
    float zs = p.z + uB.y, zq = (zs - (floor(zs / SP) + .5) * SP) / SS;
    float bound = max(zq - 170., -zq - 132.); // before the slot hash: longest possible ship
    if (bound > 6.) { gSafe = min(gSafe, bound * SS); return 1e9; }
    vec3 q = shipQ(p, rn, L);
    bound = max(length(q.xy) - 22., max(q.z - L - 50., -q.z - L - 12.));
    if (bound > 6.) { gSafe = min(gSafe, bound * SS); return 1e9; }
    vec3 a = abs(q);
    vec2 hs = vec2(7., 4.5) * taper(q.z / L);

    // glow sources: ion exhaust (stretched aft), nacelle reactor rings, running lights
    float xx = q.x - clamp(floor(q.x / 3.2 + .5), -1., 1.) * 3.2;
    float nr = length(vec2(xx, q.y)), ez = q.z - L - 5.;
    vec3 qp = vec3(a.x - 11.5, q.y + .5, q.z - L * .5);
    float pr = length(qp.xy), pz = qp.z - L * .38;
    float eng = min(length(vec3(xx, q.y, ez > 0. ? ez * .12 : ez * 2.)),
                    length(vec3(qp.xy, pz > 0. ? pz * .15 : pz * 2.)));
    float rz = qp.z - clamp(floor(qp.z / (L * .2) + .5), -1., 1.) * L * .2;
    float ring = length(vec2(pr - 2.75, rz)) - .3;
    float zl = (clamp(floor(q.z / 30.), -3., 2.) + .5) * 30.;
    float run = length(vec3(a.x - hs.x - .9, q.y, q.z - zl)) + 50. * step(.8 * L, abs(zl));
    run = min(run, length(vec3(a.x - 1.5, q.y, q.z + L + .4)));
    gL.yzw = SS * vec3(run, eng, ring);

    // coarse hull
    float d = sdB(a - vec3(hs, L));
    d = max(d, (a.x / hs.x + a.y / hs.y - 1.8) * 3.5 * hs.y / 4.5);
    d += .35 * smoothstep(.5, .15, abs(mod(q.z, 8.) - 4.));
    d = min(d, sdB(vec3(a.x - hs.x - .5, a.y - 1.6, abs(q.z - L * .05) - L * .7)));  // armour belt
    d = min(d, sdB(abs(q - vec3(0., 5.5, L * .25)) - vec3(3.8, 2.5, L * .45)));      // superstructure
    d = min(d, sdB(abs(q - vec3(0., 8.2, L * .38)) - vec3(2.6, 1.6, L * .22)));
    d = min(d, sdB(abs(q - vec3(0., 10.5, L * .5)) - vec3(2., 2., 6.)));             // bridge
    d = min(d, sdB(abs(q - vec3(0., -5.5, -L * .05)) - vec3(1.2, 2., L * .55)));     // cargo spine
    d = min(d, max(pr - 2.6 + .25 * smoothstep(.5, .2, abs(mod(q.z, 5.) - 2.5)), abs(qp.z) - L * .38)); // nacelles
    d = min(d, max(sdB(abs(vec3(a.x - 8.5, q.y + .5, mod(q.z, 18.) - 9.)) - vec3(3., .45, 1.6)), abs(qp.z) - L * .34));
    d = min(d, sdB(abs(q - vec3(0., 0., L + 1.)) - vec3(5.2, 3.6, 2.)));             // engine block
    if (gLod > .5 || gT > 420.) return d * SS;
    vec3 cq = vec3(a.x - 1.3, -q.y - hs.y - .3, q.z);
    float creg = sdB(vec3(abs(cq.x - 2.2) - 2.2, abs(cq.y - 1.5) - 1.5, abs(q.z + L * .05) - L * .5));
    float rig = min(sdB(abs(q - vec3(0., 12.75, L * .25)) - vec3(3.4, 5., L * .43)),
                    sdB(abs(q - vec3(0., 8.5, -L * .1)) - vec3(.3, 4.2, L * .62)));
    float env = min(min(d - 2.4, creg), rig);
    env = min(env, sdB(abs(q - vec3(0., 0., -L - 5.)) - vec3(1.9, .3, 5.2)));
    env = min(env, sdB(abs(q - vec3(0., -10.5, 0.)) - vec3(3.3, 2.3, L * .6)));
    if (env > .6) { gSafe = min(gSafe, env * SS); return d * SS; }
    gSafe = min(gSafe, 1.2 * SS);

    // ion thrusters: three main bells and one per nacelle
    float nz = q.z - L - 4.;
    d = min(d, max(abs(nr - 1.05 - .2 * nz) - .1, abs(nz) - 1.2));
    d = min(d, max(abs(pr - 2.1 - .25 * (pz - .8)) - .12, abs(pz - .8) - .9));
    gS.x = min(max(nr - 1.25, L + 2.9 - q.z), max(pr - 2.3, -.05 - pz));
    // reactor rings
    d = min(d, ring);
    gS.y = ring;
    // bow lances, belly aerials
    d = min(d, sdB(vec3(abs(a.x - 1.6) - .08, a.y - .08, abs(q.z + L + 5.) - 5.)));
    d = min(d, max(sdB(vec3(abs(a.x - 3.) - .06, abs(q.y + 9.) - 3.5, abs(mod(q.z, 22.) - 11.) - .06)), abs(q.z) - L * .6));
    // antenna masts with crossbars; rigging: sagging wires between posts, a stay from bow to bridge
    if (rig < 2.) {
        float mi = floor(q.z / 7.);
        vec3 mr = h23(vec2(mi, rn.x * 37.));
        vec3 mq = vec3(q.x - (mr.x - .5) * 5., q.y, q.z - (mi + .5) * 7. - (mr.z - .5) * 3.);
        float mh = 2. + 6. * mr.y * mr.y;
        float m = sdB(vec3(abs(mq.x) - .07, abs(q.y - 6.5 - mh * .5) - 2.5 - mh * .5, abs(mq.z) - .07));
        m = min(m, sdB(vec3(abs(mq.x) - .7, abs(q.y - 8. - mh * .8) - .05, abs(mq.z) - .05)));
        m = min(m, sdB(vec3(abs(mq.x) - .05, abs(q.y - 8.4 - mh * .55) - .04, abs(mq.z) - .5)));
        float deck = abs(q.z - L * .25) - L * .43;
        d = min(d, max(m, deck));
        float wf = fract(q.z / 14.) - .5;
        float wr = length(vec2(a.x - 2.4, q.y - 13.2 + 1.6 * (1. - 4. * wf * wf))) - .045;
        wr = min(wr, sdB(vec3(abs(a.x - 2.4) - .09, abs(q.y - 8.6) - 4.6, (.5 - abs(wf)) * 14. - .09)));
        d = min(d, max(wr, deck));
        vec2 sa = vec2(q.z + L * .7, q.y - 4.6), sb = vec2(L * 1.2 - 6., 7.9);
        d = min(d, length(vec2(q.x, length(sa - sb * clamp(dot(sa, sb) / dot(sb, sb), 0., 1.)))) - .05);
    }
    // gun turrets along the deck edge
    vec3 gq = vec3(a.x - hs.x * .7, q.y - hs.y - .2, q.z - (floor(q.z / 16.) + .5) * 16.);
    float gun = min(length(gq) - .75, sdB(abs(gq + vec3(0., .3, 0.)) - vec3(1., .25, 1.)));
    vec3 gn = vec3(.55, .45, -.704);
    gun = min(gun, length(gq - gn * clamp(dot(gq, gn), 0., 2.8)) - .11);
    d = min(d, max(gun, abs(q.z) - L * .8));
    // docking bays cut into the armour belt
    float bi = floor(q.z / 30. + .5);
    float bay = sdB(vec3(abs(a.x - hs.x - .5) - 1.7, a.y - 1.05, abs(q.z - bi * 30.) - 4.5));
    if (h21(vec2(bi + 7. * sign(q.x), rn.y * 53.)) > .3 && abs(bi * 30.) < L * .6) {
        d = max(d, -bay);
        gS.z = bay;
        gL.x = min(gL.x, SS * (max(bay, 0.) + 1.6));
    }
    // cargo containers slung under the hull, either side of the spine
    if (gT < 220.) {
        vec3 cc = vec3(2.2, 1.5, 3.6), ci = floor(cq / cc), cf = abs(cq - (ci + .5) * cc);
        float ch = h21(ci.xz * 1.7 + ci.y * 13. + rn.y * 71. + 5. * sign(q.x));
        float cd = min(min(cc.x * .5 - cf.x, cc.y * .5 - cf.y), cc.z * .5 - cf.z) + .1; // cell wall guard
        if (ch > .22) cd = min(cd, sdB(cf - vec3(1., .66, 1.68)));
        cd = max(cd, creg);
        if (cd < d) { d = cd; gS.w = 1. + ch; }
        // greebles on the deck and the flanks
        vec2 gc = floor(q.xz / vec2(2.5, 3.)), gf = abs(q.xz - (gc + .5) * vec2(2.5, 3.));
        vec3 gr = h23(gc + rn.xy * 50.);
        float g = min(sdB(vec3(gf.x - .3 - .7 * gr.x, q.y - hs.y - 1.4 * gr.y * gr.y, gf.y - .4 - .9 * gr.z)),
                      min(1.25 - gf.x, 1.5 - gf.y) + .15);
        d = min(d, max(g, max(max(a.x - hs.x * .75, abs(q.z) - L), -q.y))); // deck only: not out through the belly
        gc = floor(q.yz / vec2(1.5, 2.5)), gf = abs(q.yz - (gc + .5) * vec2(1.5, 2.5));
        gr = h23(gc + rn.yz * 31. + 9. * sign(q.x));
        g = min(sdB(vec3(gf.x - .2 - .4 * gr.x, a.x - hs.x - .05 - .5 * gr.y * gr.y, gf.y - .3 - .8 * gr.z)),
                min(.75 - gf.x, 1.25 - gf.y) + .15);
        d = min(d, max(g, max(a.y - hs.y * .7, abs(q.z) - L)));
    } else if (creg < d) { d = creg; gS.w = 1.5; }
    return d * SS;
}

// ---------------------------------------------------------------- station
// map() returns the distance to the surfaces it actually evaluated and puts every
// "nothing closer than this" bound into gSafe, so shadow penumbras never see the bounds.

// One city cell: plateau height B, building height ht (0 on avenues), footprint b (cell fractions).
// id is wrapped, bid/br are its district and the district's hash.
void cell(vec2 id, vec2 bid, vec3 br, out float B, out float ht, out vec2 b, out vec3 rn) {
    vec2 lc = id - bid * 20.;
    rn = h23(id + 171.);
    B = floor(br.x * 4.) * .25;
    ht = .1 + 1.7 * rn.x * rn.x * rn.x * (.4 + .9 * br.y);
    if (lc.x < .5 || lc.y < .5 || br.z < .07) ht = 0.;
    b = .3 + .19 * rn.yz;
}

float city(float a, float h, float z, float r) {
    // district: an arcology tower on a few of them, and a rooftop bound for the small buildings
    float ca = TAU / NB, d = 1e9;
    vec2 g = vec2(a / ca, z / CB), id = floor(g), f = abs(g - id - .5), cw = vec2(ca * r, CB);
    vec3 br = h23(vec2(mod(id.x, NB), mod(id.y, ZP / CB)) + .5);
    float wall = min((.5 - f.x) * cw.x, (.5 - f.y) * cw.y); // distance to the district boundary
    gSafe = min(gSafe, wall + 4.4);                         // a neighbour's tower is at least this far
    float tw = fract(dot(br, vec3(17.1, 31.7, 47.3)));
    if (tw > .86) {
        vec2 q = f * cw, b = (.12 + .1 * br.y) * cw;
        float ht = 7. + 17. * fract(tw * 13.);
        d = min(sdB(vec3(q.x - b.x, h - ht, q.y - b.y)), sdB(vec3(q.x - b.x * .55, h - ht * 1.3, q.y - b.y * .6)));
    }
    if (gLod > 1.5) return d;
    float B0 = floor(br.x * 4.) * .25, K = br.z < .07 ? 0. : .4 + .9 * br.y;
    float Hd = B0 + .13 + 2.21 * K;
    float bound = min(h - Hd, max(wall, h - 3.8));
    if (bound > .2) { gSafe = min(gSafe, bound); return d; }
    ca = TAU / NS;
    vec2 cs = vec2(ca * r, CS), gc = vec2(a / ca, z / CS);

    // the city itself: tiny buildings on district plateaus, 2x2 nearest cells
    vec2 i0 = floor((g = gc) - .5), last = vec2(-1.);
    for (int k = 0; k < 4; k++) {
        vec2 ci = i0 + vec2(k & 1, k >> 1), b;
        vec2 cm = vec2(mod(ci.x, NS), mod(ci.y, ZP / CS)), bid = floor(cm / 20.);
        if (bid != last) { br = h23(bid + .5); last = bid; }
        float B, ht; vec3 rn;
        cell(cm, bid, br, B, ht, b, rn);
        vec2 q = abs((g - ci - .5) * cs);
        d = min(d, sdB(vec3(q.x - .5 * cs.x, h - B, q.y - .5 * cs.y)));
        if (ht > 0.) {
            b *= cs;
            d = min(d, sdB(vec3(q.x - b.x, h - B - ht, q.y - b.y)));
            if (rn.y > .5) d = min(d, sdB(vec3(q.x - b.x * .55, h - B - ht * 1.3, q.y - b.y * .55)));
        }
    }
    vec2 e = min(g - i0, 2. - g + i0) * cs;
    gSafe = min(gSafe, min(e.x, e.y));
    return d;
}

float map(vec3 p) {
    gSafe = 1e9; gMat = 0.; gL = vec4(1e3); gS = vec4(1., 1., 1., 0.);
    float r = length(p.xy), h = R - r, ds = 1e9;
    if (r < 54.) ds = ships(p); else gSafe = r - 46.;
    if (h > 39.) { // open interior: nothing of the station reaches this far in
        gSafe = min(gSafe, h - 34.5);
        gMat = 1.;
        return ds;
    }
    vec2 sp = rot(p.xy, uB.z);
    float a = atan(sp.y, sp.x);
    float z = mod(p.z + uB.x, ZP);
    float zr = mod(z, RP) - 56.; // 0 at the rib; the ring of city spans |zr| < 40

    // the city and its ribs exist only on the ring; between rings there is open space
    float d = 1e9, bb = sdB2(vec2(abs(zr) - 40., abs(h - 14.) - 20.));
    if (bb < .5) {
        d = min(h, city(a, h, z, r));
        // great ribs with notched crown; every fourth is a major arch
        float big = step(mod(floor(z / RP), 4.), .5);
        float rh = 12. + 10. * big, rw = 3. + 2. * big;
        float an = abs(fract(a / TAU * 24.) - .5);
        d = min(d, sdB2(vec2(abs(zr) - rw + .5 * step(.55, fract(h / 2.4)), h - rh + 3. * step(.38, an))));
        d = min(d, sdB2(vec2(abs(zr) - rw - 1.5, h - 5.)));
        // hexagonal truss spanning the rib
        float a6 = mod(a + PI / 6., PI / 3.) - PI / 6.;
        vec2 c = r * vec2(cos(a6), sin(a6));
        d = min(d, sdB2(vec2(abs(c.x - 80.) - 1.2, abs(abs(zr) - 2.2) - .7)));
        d = min(d, sdB(vec3(abs(c.x - 80.) - .5, abs(mod(c.y, 5.) - 2.5) - .4, abs(zr) - 2.2)));
        // elevated transit lines down the middle of the cross avenues
        d = min(d, sdB2(vec2(abs(mod(z + 7.6, 16.) - 8.) - .18, h - 1.5)));
        // pipe mains circling the ring near its edges
        d = min(d, length(vec2(abs(zr) - 38.2, h - 1.7)) - 1.1 - .2 * step(abs(fract(a / TAU * 120.) - .5), .06));
        d = min(d, length(vec2(abs(abs(zr) - 35.2) - .8, h - 3.4)) - .3);
        // lamps on the rib crowns
        gL.x = min(gL.x, length(vec3((fract(a / TAU * 12.) - .5) * TAU / 12. * r, h - rh - 1., zr)));
        d = max(d, bb);
    } else gSafe = min(gSafe, bb);

    // spanning the gaps: trunk pipes over the long avenues, heavy conduits, hanging cables
    float fa = abs(fract(a / TAU * NB - .025) - .5);
    d = min(d, length(vec2((.5 - fa) * TAU / NB * r, h - 1.6)) - .3);
    float f8 = (fract(a / TAU * 8. + .3) - .5) * TAU / 8. * r;
    d = min(d, length(vec2(f8, h + 1.)) - 1.6 - .25 * step(abs(mod(z, 6.) - 3.), .3));
    d = min(d, length(vec2(abs(f8) - 2.6, h + .4)) - .5);
    if (gT < 260.) {
        float u = fract(zr / RP);
        float fw = (fract(a / TAU * 24. + .5) - .5) * TAU / 24. * r;
        d = min(d, length(vec2(abs(abs(fw) - .9) - .35, h - 11. + 20. * u * (1. - u))) - .08);
    }

    if (ds < d) { gMat = 1.; return ds; }
    return d;
}

vec3 normal(vec3 p, float e) {
    vec2 k = vec2(1., -1.);
    vec3 v = k.xyy * map(p + k.xyy * e) + k.yyx * map(p + k.yyx * e) +
             k.yxy * map(p + k.yxy * e) + k.xxx * map(p + k.xxx * e);
    return v / max(length(v), 1e-6); // the four taps can cancel exactly on a symmetry plane
}

float shadow(vec3 p, vec3 l, float mx) {
    float s = 1., t = .05;
    for (int i = 0; i < 22; i++) {
        float d = map(p + l * t);
        s = min(s, 10. * d / t);
        if (s < .01 || t > mx) break;
        if (t > 4.) gLod = 2.; // only nearby detail casts shadows; beyond that the big shapes do
        t += clamp(min(d, gSafe), .04, 40.);
    }
    return smoothstep(0., 1., max(s, 0.));
}

float ao(vec3 p, vec3 n, float sc) {
    float o = 0., w = 1.;
    for (int i = 0; i < 2; i++) {
        float h = sc * (.3 + 1.1 * float(i));
        o += w * (h - map(p + n * h));
        w *= .5;
    }
    return clamp(1. - .45 * o / sc, 0., 1.);
}

// ---------------------------------------------------------------- surfaces
// q: unrolled surface coords, n: normal in that frame, px: pixel footprint.
// Each returns albedo, with emission in em and roughness in rough.
vec2 faceUV(vec3 q, vec3 n) {
    vec3 an = abs(n);
    return an.y > .6 ? q.xz : (an.x > an.z ? q.zy : q.xy);
}

vec3 megaSkin(vec3 q, vec3 n, float t, float px, vec3 pc, out vec3 em, out float rough) {
    vec2 uv = faceUV(q, n);
    vec3 alb = rust(uv, px, 0., rough);
    vec2 f1 = fract(uv / vec2(6.4, 3.2)); // plate seams
    float seam = smoothstep(0., .03 + px, min(min(f1.x, 1. - f1.x) * 6.4, min(f1.y, 1. - f1.y) * 3.2));
    alb *= mix(1., .7 + .3 * seam, smoothstep(220., 30., t));
    em = vec3(0.);
    if (abs(n.y) < .6) {
        vec2 wu = uv / vec2(.125, .1), wc = floor(wu), wf = fract(wu);
        float frac = .035 * smoothstep(.45, .7, fbm(uv, vec2(.125), 0., 2)); // lit floors cluster softly
        float lit = step(1. - frac, h21(wc + .5)) * step(.2, wf.x) * step(wf.x, .8) * step(.3, wf.y) * step(wf.y, .75);
        vec3 wcol = mix(vec3(1., .5, .15), mix(pc, vec3(1.), .6), step(.7, h21(wc + 9.)));
        em = mix(frac * .27 * vec3(1., .6, .3), lit * wcol, smoothstep(90., 25., t)) * 2.5;
    }
    return alb;
}

vec3 stationSkin(vec3 q, vec3 n, float t, float px, vec3 pc, out vec3 em, out float rough) {
    float ca = TAU / NS, r = R - q.y;
    vec2 g = vec2(q.x / R / ca, q.z / CS), id = floor(g), b;
    float B, ht; vec3 rn;
    vec2 cm = vec2(mod(id.x, NS), mod(id.y, ZP / CS)), bid = floor(cm / 20.), lc = cm - bid * 20.;
    cell(cm, bid, h23(bid + .5), B, ht, b, rn);
    vec2 f = (g - id - .5) * vec2(ca * r, CS);
    bool inside = abs(f.x) < b.x * ca * r + .02 && abs(f.y) < b.y * CS + .02;
    if (abs(mod(q.z, RP) - 56.) > 39.9 || q.y < -.05 || q.y > B + ht * 1.3 + .06 || (q.y > B + .04 && !(inside && ht > 0.)))
        return megaSkin(q, n, t, px, pc, em, rough);

    vec3 warm = vec3(1., .5, .15);
    vec3 wcol = mix(warm, mix(pc, vec3(1.), .6), step(.78, rn.y));
    vec3 alb = rust(faceUV(q, n), px, .04, rough);
    if (n.y < .6) { // walls: a few lit floors, most buildings dark
        float lum = .012 + 1.6 * pow(h21(id + 3.), 7.);
        float fl = step(.45, fract(q.y / .05)) * step(.4, fract((abs(n.x) > abs(n.z) ? q.z : q.x) / .04));
        em = wcol * lum * mix(.25, fl, smoothstep(30., 8., t));
        return alb;
    }
    if (q.y < B + .04) { // streets; avenues carry traffic in two lanes
        em = warm * .03;
        if (min(lc.x, lc.y) < .5) {
            bool lon = lc.x < .5;
            float along = (lon ? q.z : q.x) / .4, across = lon ? f.x : f.y;
            float dir = sign(across);
            float cx = along - dir * uD.w * (.6 + .4 * h21(vec2(lon ? id.x : id.y, 2.)));
            float car = step(.7, h21(vec2(mod(floor(cx), 256.), (lon ? id.x : id.y) + 40. * dir)));
            car *= smoothstep(.3, .1, abs(fract(cx) - .5)) * smoothstep(.1, .04, abs(abs(across) - .24));
            vec3 cc = dir > 0. ? vec3(1., .9, .7) : vec3(1., .12, .05);
            em = warm * .07 + mix(cc * .012, car * cc * 9., smoothstep(160., 50., t));
        }
        rough = .8;
        return alb * .7;
    }
    // roofs: sparse beacons, the odd lit pad
    float rh = h21(id + 9.);
    em = wcol * step(.94, rh) * mix(.12, 9. * smoothstep(.07, .025, length(f)), smoothstep(100., 30., t));
    return alb;
}

vec3 shipSkin(vec3 q, vec3 n, float t, float px, vec3 pc, vec4 tag, out vec3 em, out float rough) {
    vec2 uv = faceUV(q, n);
    float fd = smoothstep(300., 50., t);
    vec3 alb = rust(uv, px, -.2, rough) * 1.2;
    vec2 f1 = fract(uv / vec2(4.8, 2.25)); // hull plating
    float seam = smoothstep(0., .025 + px, min(min(f1.x, 1. - f1.x) * 4.8, min(f1.y, 1. - f1.y) * 2.25));
    alb *= mix(1., .72 + .28 * seam, fd);
    em = vec3(0.);
    if (tag.w > .5) { // containers: one faded paint over the same corrosion
        alb = mix(vec3(.11, .075, .055), alb * 1.5, .6);
        rough = .7;
    } else if (abs(n.y) < .6) { // rows of tiny windows
        vec2 wu = uv / vec2(.22, .3), wc = floor(wu), wf = fract(wu);
        float row = step(.6, h21(vec2(wc.y, floor(uv.x / 6.) + 2.)));
        float lit = row * step(.5, h21(wc + .5)) * step(.25, wf.x) * step(wf.x, .75) * step(.3, wf.y) * step(wf.y, .7);
        vec3 wcol = mix(vec3(1., .75, .45), vec3(.7, .9, 1.), step(.8, h21(wc + 9.)));
        em = mix(vec3(.025) * vec3(1., .8, .6), lit * wcol, smoothstep(170., 60., t)) * 2.5;
    } else { // deck lights
        vec2 dc = floor(uv / .9);
        em = vec3(1., .6, .3) * step(.95, h21(dc + 4.)) * smoothstep(.2, .08, length(fract(uv / .9) - .5)) * 5. * fd;
    }
    if (tag.z < .03) em += vec3(1., .8, .5) * (1.8 + 1.4 * step(.5, fract(q.z * .8)));
    if (tag.x < 0.) em += vec3(.6, .8, 1.) * 12. * smoothstep(0., -.6, tag.x);
    em += vec3(.3, .75, 1.) * 12. * pulse(q.z) * smoothstep(.1, .0, tag.y);
    return alb;
}

// ---------------------------------------------------------------- light and fog
// Drone j of a ship, in the ship frame: a slow orbit around the hull, drifting along its length.
// Rates are whole turns per 1024 s so the motion survives the wrap of uD.w. The host mirrors
// this (drone_pos in main.c) to put a camera on drone 0, so the hash takes whole numbers only:
// hashing a hash would amplify the last-bit differences between GPU and CPU arithmetic.
vec3 dronePos(float j, float slot, float L) {
    vec3 h = h23(vec2(j * 7. + 1., slot + 91.));
    float n = j < .5 ? 8. : (12. + floor(h.x * 12.)) * (h.z > .5 ? 1. : -1.);
    float a = TAU * (h.y + n * uD.w / 1024.);
    float z = L * .8 * sin(TAU * (h.x + (3. + floor(h.y * 4.)) * uD.w / 1024.));
    return vec3((20. + 5. * h.z) * vec2(cos(a), sin(a)), z);
}

// Each drone carries a narrow seeking light: it points away from the ship and hunts about,
// picking a new heading every 8 s.
vec3 droneAim(float k, float slot, vec3 o) {
    float sd = fract(k * .37 + slot * .113), x = uD.w / 8.;
    vec2 i = floor(vec2(x, x + 40.5)), f = fract(vec2(x, x + 40.5));
    f = f * f * (3. - 2. * f);
    vec2 w = vec2(mix(h21(vec2(mod(i.x, 128.), sd)), h21(vec2(mod(i.x + 1., 128.), sd)), f.x),
                  mix(h21(vec2(mod(i.y, 128.), sd + .5)), h21(vec2(mod(i.y + 1., 128.), sd + .5)), f.y)) - .5;
    vec2 out2 = normalize(o.xy);
    return normalize(vec3(out2 + vec2(-out2.y, out2.x) * w.x * 2.2, w.y * 2.2));
}

// Searchlight irradiance at p from the ship in p's slot; l is the direction it arrives from.
float spotAt(vec3 p, out vec3 l) {
    vec3 rn; float L;
    vec3 q = shipQ(p, rn, L), o, u;
    l = -normalize(vec3(rot(q.xy, -(rn.z - .5) * 1.2), 0.));
    float k0 = floor(q.z / 30.), acc = 0.;
    for (float k = k0 - 1.; k < k0 + 1.5; k++) { // beams lean fore and aft, so try the neighbours too
        if (k < -3. || k > 2. || beamRay(k, sign(q.x), rn, L, o, u) < .5) continue;
        vec3 v = q - o;
        float al = dot(v, u);
        if (al < 0.) continue;
        float w = .3 + al * .045;
        acc += exp(-dot(v - u * al, v - u * al) / (w * w)) / (w * w * (1. + al * al / 3600.));
    }
    // and the small pools from the drones' seeking lights
    float slot = mod(floor((p.z + uB.y) / SP), 64.);
    for (float k = 0.; k < 5.; k++) {
        o = dronePos(k, slot, L);
        u = droneAim(k, slot, o);
        vec3 v = q - o;
        float al = dot(v, u);
        if (al < 0.) continue;
        float w = .1 + al * .022;
        acc += .12 * exp(-dot(v - u * al, v - u * al) / (w * w)) / (w * w * (1. + al * al / 2500.));
    }
    return acc;
}

// Searchlight shafts in the fog: closest approach of the view ray to each beam axis.
float beams(vec3 ro, vec3 rd, float tmax) {
    float acc = 0., f = uB.y / SP, id0 = floor(f);
    for (int j = 0; j < 2; j++) {
        float id = id0 + float(j) * (fract(f) > .5 ? 1. : -1.);
        vec3 rn, o, u; float L, roll;
        shipSlot(id, rn, L, roll);
        if (uC.w * ((id + .5) * SP - uB.y) + (L + 50.) * SS < 0.) continue; // wholly behind the camera
        vec3 q0 = vec3(ro.xy - (rn.yz - .5) * vec2(16., 8.), ro.z + uB.y - (id + .5) * SP) / SS;
        q0.xy = rot(q0.xy, roll);
        vec3 qd = vec3(rot(rd.xy, roll), rd.z);
        for (int k = -3; k < 3; k++)
            for (float s = -1.; s < 2.; s += 2.) {
                if (beamRay(float(k), s, rn, L, o, u) < .5) continue;
                vec3 w0 = q0 - o;
                float b = dot(qd, u), dq = dot(qd, w0), e = dot(u, w0), den = max(1. - b * b, .03);
                float al = max((e - b * dq) / den, 0.);
                float tv = dot(o + u * al - q0, qd);
                if (tv < 0. || tv * SS > tmax) continue;
                vec3 dv = q0 + qd * tv - o - u * al;
                float w = .3 + al * .045;
                float wall = smoothstep(R - 1., R - 8., length((ro + rd * tv * SS).xy));
                // fades out right at the lens: a camera flying through a beam would otherwise see a hard wedge
                acc += exp(-dot(dv, dv) / (w * w)) / (w * sqrt(den) * (1. + al * al / 5000.)) * wall * exp(-tv * SS * .0028) * smoothstep(0., 10., tv);
            }
    }
    return acc;
}

// Light from the drones along a view ray: each is a point, so take the ray's closest approach.
float drones(vec3 ro, vec3 rd, float tmax, float px) {
    float acc = 0., f = uB.y / SP, id0 = floor(f);
    for (int j = 0; j < 2; j++) {
        float id = id0 + float(j) * (fract(f) > .5 ? 1. : -1.);
        vec3 rn; float L, roll;
        shipSlot(id, rn, L, roll);
        vec3 q0 = vec3(ro.xy - (rn.yz - .5) * vec2(16., 8.), ro.z + uB.y - (id + .5) * SP) / SS;
        q0.xy = rot(q0.xy, roll);
        vec3 qd = vec3(rot(rd.xy, roll), rd.z);
        for (float k = 0.; k < 5.; k++) {
            vec3 v = dronePos(k, mod(id, 64.), L) - q0;
            float tv = dot(v, qd), d2 = dot(v, v) - tv * tv;
            if (tv < 0. || tv * SS > tmax || dot(v, v) < 4.) continue; // behind, hidden, or the one we ride
            float r = max(.06, .8 * px * tv * SS); // never thinner than a pixel
            acc += (30. * exp(-d2 / (r * r)) + .5 / (25. * d2 + .6) + .06 / (d2 * .5 + 1.)) * exp(-tv * SS * .003);
        }
        // their seeking lights as thin shafts in the fog: closest approach of view ray and beam axis
        for (float k = 0.; k < 5.; k++) {
            vec3 o = dronePos(k, mod(id, 64.), L), u = droneAim(k, mod(id, 64.), o), w0 = q0 - o;
            float b = dot(qd, u), dq = dot(qd, w0), e = dot(u, w0), den = max(1. - b * b, .03);
            float al = max((e - b * dq) / den, 0.);
            float tv = dot(o + u * al - q0, qd);
            if (tv < 0. || tv * SS > tmax) continue;
            vec3 dv = q0 + qd * tv - o - u * al;
            float w = .1 + al * .022;
            float wall = smoothstep(R - 1., R - 8., length((ro + rd * tv * SS).xy));
            acc += .035 * exp(-dot(dv, dv) / (w * w)) / (w * sqrt(den) * (1. + al * al / 2500.)) * wall * exp(-tv * SS * .0028) * smoothstep(0., 10., tv);
        }
    }
    return acc;
}

// Fog as a medium with weather: dense clouds of smog drift down the tube towards the camera,
// which flies through them; thinner haze between, mist pooled against the city, and enough
// of it overall that the far tunnel is lost. T = transmittance.
vec3 fog(vec3 ro, vec3 rd, float t, float hue, vec3 lp, vec3 kc, float jit, out float T) {
    const int N = 16;
    float ax = max(rd.z * uC.w, 0.);
    float c1 = cos(uB.z), s1 = sin(uB.z);
    mat2 ra = mat2(c1, -s1, s1, c1), rb = mat2(c1 * c1 - s1 * s1, 2. * s1 * c1, -2. * s1 * c1, c1 * c1 - s1 * s1);
    vec3 acc = vec3(0.);
    float t0 = 0.;
    T = 1.;
    for (int i = 0; i < N; i++) {
        float x = float(i + 1) / float(N), t1 = t * x * sqrt(x);
        float ti = mix(t0, t1, jit), dt = t1 - t0;
        t0 = t1;
        vec3 p = ro + rd * ti;
        float h = R - length(p.xy);
        if (h < -2.) continue; // outside the tube: vacuum
        float z = p.z + uB.w;  // the weather's own frame, moving faster than the station
        float n = texture(uN, vec3(ra * p.xy, z) / 512.).r, m = texture(uN, vec3(rb * p.xy, z) / 128. + .37).r;
        float cl = smoothstep(.48, .60, n * .78 + m * .3);
        float mist = exp(-max(h, 0.) / 8.) * (4. * m - .9);
        float tr = exp(-(.0022 + .030 * cl * cl + .012 * max(mist, 0.)) * dt);
        vec3 fc = pal(hue + ti * rd.z * .00016);
        vec3 lv = lp - p;
        float l2 = dot(lv, lv), ph = .35 + .65 * pow(max(dot(rd, lv) * inversesqrt(l2), 0.), 4.);
        // cloud cores shadow themselves; their thin edges catch the light
        vec3 S = (fc * (.034 + .07 * pow(ax, 6.)) + vec3(.014, .010, .007)) * (1. + .5 * cl) + kc * ph * .30 * (1. - .7 * cl) / (1. + l2 / 26000.) +
                 mix(fc, vec3(1., .5, .15), .5) * .035 * max(mist, 0.);
        acc += T * (1. - tr) * S;
        T *= tr;
    }
    return acc;
}

// Three shells of a 3D star field. Each drifts at its own rate as the camera travels (wrapping
// with the station offset), so the layers slide over each other; points stay round everywhere.
vec3 stars(vec3 rd) {
    vec3 c = vec3(0.);
    for (int i = 0; i < 3; i++) {
        float N = i == 0 ? 64. : i == 1 ? 44. : 28., k = i == 0 ? 1. / 64. : i == 1 ? 1. / 16. : 1. / 4.;
        vec3 p = rd * N + vec3(0., 0., uB.x * k), id = floor(p);
        vec3 h = h23(id.xy + mod(id.z, ZP * k) * 31.7 + float(i) * 9.);
        vec3 f = p - id - .2 - .6 * fract(h * 7.3);
        float r = N * .0011 * (.6 + h.y);
        c += step(.55, h.x) * exp(-dot(f, f) / (r * r)) * (.25 + 2.5 * h.z * h.z) * mix(vec3(1., .82, .65), vec3(.7, .85, 1.), h.y);
    }
    return c;
}

void main() {
    // lens: flat perspective, or (pixel aspect < 0) half a sphere unrolled by longitude and latitude
    vec2 fc = (gl_FragCoord.xy + uE.xy) * 2. - uA.xy, la = fc / uA.xy * (PI * .5);
    vec3 ro = uC.xyz;
    vec3 rd = uM * (uE.z < 0. ? vec3(sin(la.x) * cos(la.y), sin(la.y), cos(la.x) * cos(la.y))
                             : normalize(vec3(fc / uA.y * vec2(uE.z, 1.) + vec2(uE.w, 0.), 1.25)));
    float pxk = uE.z < 0. ? PI / uA.y : 1. / (uA.y * .625); // angle one pixel covers

    float jit = h21(gl_FragCoord.xy + fract(uA.z * 7.31) * 97.); // per pixel, per frame; averaged by the temporal pass
    float t = 0., hit = 0., sky = 0.;
    gH = 0.;
    vec4 glow = vec4(0.);
    gLod = 0.;
    for (int i = 0; i < 260; i++) {
        vec3 p = ro + rd * t;
        if (dot(p.xy, p.xy) > 125. * 125.) { sky = 1.; break; } // left through a gap between rings
        gT = t;
        float d = map(p);
        float st = min(d, gSafe);
        // glows are integrated along the ray, so near a light the steps must stay short and off-grid
        float gd = min(min(gL.x, gL.y), min(gL.z, gL.w));
        if (gd < 20.) st = min(st, (.35 + .3 * gd) * (.6 + .8 * jit));
        glow += st * exp(-gL * vec4(.45, .55, .5, .7));
        if (d < .001 + .0008 * t) { hit = 1.; break; }
        t += st;
        if (t > FAR) break;
    }
    t = min(t, FAR);
    gT = t;

    float hue = uA.w, mat = 0.;
    vec3 pc = pal(hue + t * rd.z * .00016);        // local hue at the hit
    vec3 lp = vec3(-ro.x * .5 + 12., 30., 380. * uC.w); // key light, ahead and off-axis
    vec3 warm = vec3(1., .45, .12), ion = vec3(.55, .75, 1.), core = vec3(.3, .75, 1.);
    vec3 lite = mix(pc, vec3(1.), .55);
    vec3 kcol = mix(pal(hue + .06), vec3(1.), .12) * 5.;
    vec3 col = sky * stars(rd);
    vec3 p = ro + rd * t;

    if (hit > .5) {
        float px = t * pxk;
        vec3 n = normal(p, .0015 + .0006 * t);
        map(p);
        mat = gMat;
        vec4 hl = gL, tag = gS;
        vec3 em, alb, sl;
        float spot = 0., aos = .2, rough;
        if (mat < .5) {
            vec2 sp = rot(p.xy, uB.z), sn = rot(n.xy, uB.z);
            vec2 er = normalize(sp);
            vec3 q = vec3(atan(sp.y, sp.x) * R, R - length(sp), mod(p.z + uB.x, ZP));
            alb = stationSkin(q, vec3(dot(sn, vec2(-er.y, er.x)), -dot(sn, er), n.z), t, px, pc, em, rough);
            spot = spotAt(p, sl) * max(dot(n, sl), 0.);
        } else {
            vec3 rn; float L;
            vec3 q = shipQ(p, rn, L);
            alb = shipSkin(q + rn * 40., vec3(rot(n.xy, (rn.z - .5) * 1.2), n.z), t, px, pc, tag, em, rough);
            aos = .6;
        }

        // bump the normal with the corrosion relief, from screen-space derivatives of height and position
        vec3 dpx = dFdx(p), dpy = dFdy(p), r1 = cross(dpy, n), r2 = cross(n, dpx);
        float det = dot(dpx, r1);
        vec3 bg = (dFdx(gH) * r1 + dFdy(gH) * r2) * sign(det) * .22;
        // not across depth edges, where the neighbouring pixel is some other surface or the sky
        vec3 nb = abs(det) * n - bg * min(1., .9 * abs(det) / max(length(bg), 1e-9));
        float nl = dot(nb, nb);
        if (abs(dFdx(t)) + abs(dFdy(t)) < .02 * t + .05 && dFdx(hit) == 0. && dFdy(hit) == 0. && nl > 1e-12 && nl < 1e12)
            n = nb * inversesqrt(nl);

        vec3 l = lp - p;
        float ld = length(l);
        l /= ld;
        float ndl = max(dot(n, l), 0.);
        gLod = 1. - mat;
        float sh = ndl > 0. ? shadow(p + n * (.006 + .001 * t), l, ld) : 0.;
        gLod = 0.;
        float occ = ao(p, n, aos);
        vec3 kc = kcol / (1. + ld * ld / 60000.);
        // specular lobe narrows on bare metal, vanishes on rust
        float pw = min(2. / pow(rough, 4.), 600.);
        float spec = (1. - rough) * (pw + 8.) * .04 * pow(max(dot(n, normalize(l - rd)), 0.), pw);
        float fres = pow(1. - max(dot(n, -rd), 0.), 5.) * (1. - rough);

        col = (alb + spec) * kc * ndl * sh;
        col += alb * mix(pc * (.10 + .05 * dot(n, -normalize(vec3(p.xy, 0.)))), pc * .08 + vec3(.05, .04, .03), mat) * occ;
        col += pc * fres * occ * .06;
        col += em * (.4 + .6 * occ);
        col += alb * lite * spot * 700.;
        // light cores and their spill on nearby surfaces
        col += warm * (7. * exp(-hl.x * 2.5) + alb * 10. * exp(-hl.x * .3));
        col += lite * (9. * exp(-hl.y * 2.2) + alb * 10. * exp(-hl.y * .3));
        col += ion * alb * 16. * exp(-hl.z * .3);
        col += core * alb * 16. * pulse(0.) * exp(-hl.w * .5);
    }

    float T;
    vec3 fg = fog(ro, rd, t, hue, lp, kcol, jit, T);
    col = col * T + fg;

    col += lite * beams(ro, rd, t) * .12;
    col += lite * drones(ro, rd, t, pxk);
    col += warm * glow.x * .035;
    col += lite * glow.y * .05;
    col += ion * glow.z * .04;
    col += core * glow.w * .05 * pulse(0.);

    // alpha carries what the temporal pass needs to reproject: distance, negative on ships, huge for sky
    O = vec4(min(col, vec3(60.)), sky > .5 ? 1e5 : (mat > .5 ? -t : t));
}
