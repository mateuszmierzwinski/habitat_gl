#version 330 core
// Final image: add bloom, expose, filmic tone curve, grade, vignette, grain.
out vec4 O;
uniform sampler2D T, B; // anti-aliased scene, bloom pyramid
uniform int uF[200];    // caption text, 5 rows of 40 glyph codes (see letter())
uniform vec4 uFI;       // caption: opacity, corner (0 TL, 1 TR, 2 BL, 3 BR), widest row, rows
uniform vec4 uI;        // x: 0..1 dip to black around a camera change, y pixel aspect, zw viewport origin
uniform vec4 uO;        // overlays: xy scale of the frame about its centre, z aspect they are laid out for, w eye offset
uniform vec4 uA;        // xy output resolution, z time (wrapped), w opening time in seconds (< 0: no opening)

float h21(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * .1031);
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
}
vec3 aces(vec3 c) { return clamp(c * (2.51 * c + .03) / (c * (2.43 * c + .59) + .14), 0., 1.); }

// ---- opening title: "HABITAT" drawn as thin strokes, lit like a sign
float seg(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0., 1.));
}
// Distance to one glyph in a box 0..w wide, 0..1 tall. 0 H, 1 A, 2 B, 3 I, 4 T
float glyph(int g, vec2 p) {
    if (g == 0) return min(min(seg(p, vec2(0., 0.), vec2(0., 1.)), seg(p, vec2(.8, 0.), vec2(.8, 1.))),
                           min(seg(p, vec2(0., .5), vec2(.28, .5)), seg(p, vec2(.52, .5), vec2(.8, .5))));
    if (g == 1) return min(min(seg(p, vec2(0., 0.), vec2(.45, 1.)), seg(p, vec2(.9, 0.), vec2(.45, 1.))),
                           seg(p, vec2(.36, .26), vec2(.54, .26)));
    if (g == 2) {
        float d = min(seg(p, vec2(0., 0.), vec2(0., 1.)), seg(p, vec2(0., 1.), vec2(.58, 1.)));
        d = min(d, min(seg(p, vec2(.58, 1.), vec2(.72, .86)), seg(p, vec2(.72, .86), vec2(.72, .64))));
        d = min(d, min(seg(p, vec2(.72, .64), vec2(.58, .5)), seg(p, vec2(.2, .5), vec2(.62, .5))));
        d = min(d, min(seg(p, vec2(.62, .5), vec2(.8, .36)), seg(p, vec2(.8, .36), vec2(.8, .14))));
        return min(d, min(seg(p, vec2(.8, .14), vec2(.66, 0.)), seg(p, vec2(.66, 0.), vec2(0., 0.))));
    }
    if (g == 3) return seg(p, vec2(0., 0.), vec2(0., 1.));
    return min(seg(p, vec2(0., 1.), vec2(.8, 1.)), seg(p, vec2(.4, 0.), vec2(.4, 1.)));
}
// Distance to the whole word, p in units of letter height, centred. gap is the letter spacing.
float word(vec2 p, float gap) {
    const int G[7] = int[7](0, 1, 2, 3, 4, 1, 4);
    const float W[5] = float[5](.8, .9, .8, 0., .8);
    float x = -(4.9 + 6. * gap) * .5, d = 1e3;
    for (int i = 0; i < 7; i++) {
        d = min(d, glyph(G[i], p - vec2(x, -.5)));
        x += W[G[i]] + gap;
    }
    return d;
}
float ease(float a, float b, float x) { return smoothstep(a, b, x); }

// ---- opening card: a full alphabet in the same stroke style, laid out on a fixed advance
float letter(int c, vec2 p) {
    float d = 1e3;
    switch (c) {
    case 1: d = min(d, seg(p, vec2(0., 0.), vec2(0.4, 1.))); d = min(d, seg(p, vec2(0.8, 0.), vec2(0.4, 1.))); d = min(d, seg(p, vec2(0.3, 0.26), vec2(0.5, 0.26))); break; // A
    case 2: d = min(d, seg(p, vec2(0., 0.), vec2(0., 1.))); d = min(d, seg(p, vec2(0., 1.), vec2(0.58, 1.))); d = min(d, seg(p, vec2(0.58, 1.), vec2(0.72, 0.86))); d = min(d, seg(p, vec2(0.72, 0.86), vec2(0.72, 0.64))); d = min(d, seg(p, vec2(0.72, 0.64), vec2(0.58, 0.5))); d = min(d, seg(p, vec2(0.2, 0.5), vec2(0.62, 0.5))); d = min(d, seg(p, vec2(0.62, 0.5), vec2(0.8, 0.36))); d = min(d, seg(p, vec2(0.8, 0.36), vec2(0.8, 0.14))); d = min(d, seg(p, vec2(0.8, 0.14), vec2(0.66, 0.))); d = min(d, seg(p, vec2(0.66, 0.), vec2(0., 0.))); break; // B
    case 3: d = min(d, seg(p, vec2(0.8, 1.), vec2(0.15, 1.))); d = min(d, seg(p, vec2(0.15, 1.), vec2(0., 0.85))); d = min(d, seg(p, vec2(0., 0.85), vec2(0., 0.15))); d = min(d, seg(p, vec2(0., 0.15), vec2(0.15, 0.))); d = min(d, seg(p, vec2(0.15, 0.), vec2(0.8, 0.))); break; // C
    case 4: d = min(d, seg(p, vec2(0., 0.), vec2(0., 1.))); d = min(d, seg(p, vec2(0., 1.), vec2(0.6, 1.))); d = min(d, seg(p, vec2(0.6, 1.), vec2(0.8, 0.8))); d = min(d, seg(p, vec2(0.8, 0.8), vec2(0.8, 0.2))); d = min(d, seg(p, vec2(0.8, 0.2), vec2(0.6, 0.))); d = min(d, seg(p, vec2(0.6, 0.), vec2(0., 0.))); break; // D
    case 5: d = min(d, seg(p, vec2(0., 0.), vec2(0., 1.))); d = min(d, seg(p, vec2(0., 1.), vec2(0.8, 1.))); d = min(d, seg(p, vec2(0.2, 0.5), vec2(0.65, 0.5))); d = min(d, seg(p, vec2(0., 0.), vec2(0.8, 0.))); break; // E
    case 6: d = min(d, seg(p, vec2(0., 0.), vec2(0., 1.))); d = min(d, seg(p, vec2(0., 1.), vec2(0.8, 1.))); d = min(d, seg(p, vec2(0.2, 0.5), vec2(0.65, 0.5))); break; // F
    case 7: d = min(d, seg(p, vec2(0.8, 1.), vec2(0.15, 1.))); d = min(d, seg(p, vec2(0.15, 1.), vec2(0., 0.85))); d = min(d, seg(p, vec2(0., 0.85), vec2(0., 0.15))); d = min(d, seg(p, vec2(0., 0.15), vec2(0.15, 0.))); d = min(d, seg(p, vec2(0.15, 0.), vec2(0.8, 0.))); d = min(d, seg(p, vec2(0.8, 0.), vec2(0.8, 0.45))); d = min(d, seg(p, vec2(0.8, 0.45), vec2(0.45, 0.45))); break; // G
    case 8: d = min(d, seg(p, vec2(0., 0.), vec2(0., 1.))); d = min(d, seg(p, vec2(0.8, 0.), vec2(0.8, 1.))); d = min(d, seg(p, vec2(0., 0.5), vec2(0.28, 0.5))); d = min(d, seg(p, vec2(0.52, 0.5), vec2(0.8, 0.5))); break; // H
    case 9: d = min(d, seg(p, vec2(0.4, 0.), vec2(0.4, 1.))); break; // I
    case 10: d = min(d, seg(p, vec2(0.8, 1.), vec2(0.8, 0.15))); d = min(d, seg(p, vec2(0.8, 0.15), vec2(0.65, 0.))); d = min(d, seg(p, vec2(0.65, 0.), vec2(0.15, 0.))); d = min(d, seg(p, vec2(0.15, 0.), vec2(0., 0.15))); break; // J
    case 11: d = min(d, seg(p, vec2(0., 0.), vec2(0., 1.))); d = min(d, seg(p, vec2(0.8, 1.), vec2(0.2, 0.5))); d = min(d, seg(p, vec2(0.2, 0.5), vec2(0.8, 0.))); break; // K
    case 12: d = min(d, seg(p, vec2(0., 1.), vec2(0., 0.))); d = min(d, seg(p, vec2(0., 0.), vec2(0.8, 0.))); break; // L
    case 13: d = min(d, seg(p, vec2(0., 0.), vec2(0., 1.))); d = min(d, seg(p, vec2(0., 1.), vec2(0.4, 0.4))); d = min(d, seg(p, vec2(0.4, 0.4), vec2(0.8, 1.))); d = min(d, seg(p, vec2(0.8, 1.), vec2(0.8, 0.))); break; // M
    case 14: d = min(d, seg(p, vec2(0., 0.), vec2(0., 1.))); d = min(d, seg(p, vec2(0., 1.), vec2(0.8, 0.))); d = min(d, seg(p, vec2(0.8, 0.), vec2(0.8, 1.))); break; // N
    case 15: d = min(d, seg(p, vec2(0.15, 0.), vec2(0.65, 0.))); d = min(d, seg(p, vec2(0.65, 0.), vec2(0.8, 0.15))); d = min(d, seg(p, vec2(0.8, 0.15), vec2(0.8, 0.85))); d = min(d, seg(p, vec2(0.8, 0.85), vec2(0.65, 1.))); d = min(d, seg(p, vec2(0.65, 1.), vec2(0.15, 1.))); d = min(d, seg(p, vec2(0.15, 1.), vec2(0., 0.85))); d = min(d, seg(p, vec2(0., 0.85), vec2(0., 0.15))); d = min(d, seg(p, vec2(0., 0.15), vec2(0.15, 0.))); break; // O
    case 16: d = min(d, seg(p, vec2(0., 0.), vec2(0., 1.))); d = min(d, seg(p, vec2(0., 1.), vec2(0.65, 1.))); d = min(d, seg(p, vec2(0.65, 1.), vec2(0.8, 0.85))); d = min(d, seg(p, vec2(0.8, 0.85), vec2(0.8, 0.6))); d = min(d, seg(p, vec2(0.8, 0.6), vec2(0.65, 0.45))); d = min(d, seg(p, vec2(0.65, 0.45), vec2(0.2, 0.45))); break; // P
    case 17: d = min(d, seg(p, vec2(0.15, 0.), vec2(0.65, 0.))); d = min(d, seg(p, vec2(0.65, 0.), vec2(0.8, 0.15))); d = min(d, seg(p, vec2(0.8, 0.15), vec2(0.8, 0.85))); d = min(d, seg(p, vec2(0.8, 0.85), vec2(0.65, 1.))); d = min(d, seg(p, vec2(0.65, 1.), vec2(0.15, 1.))); d = min(d, seg(p, vec2(0.15, 1.), vec2(0., 0.85))); d = min(d, seg(p, vec2(0., 0.85), vec2(0., 0.15))); d = min(d, seg(p, vec2(0., 0.15), vec2(0.15, 0.))); d = min(d, seg(p, vec2(0.5, 0.3), vec2(0.85, -0.05))); break; // Q
    case 18: d = min(d, seg(p, vec2(0., 0.), vec2(0., 1.))); d = min(d, seg(p, vec2(0., 1.), vec2(0.65, 1.))); d = min(d, seg(p, vec2(0.65, 1.), vec2(0.8, 0.85))); d = min(d, seg(p, vec2(0.8, 0.85), vec2(0.8, 0.6))); d = min(d, seg(p, vec2(0.8, 0.6), vec2(0.65, 0.45))); d = min(d, seg(p, vec2(0.65, 0.45), vec2(0.2, 0.45))); d = min(d, seg(p, vec2(0.45, 0.45), vec2(0.8, 0.))); break; // R
    case 19: d = min(d, seg(p, vec2(0.8, 0.85), vec2(0.65, 1.))); d = min(d, seg(p, vec2(0.65, 1.), vec2(0.15, 1.))); d = min(d, seg(p, vec2(0.15, 1.), vec2(0., 0.85))); d = min(d, seg(p, vec2(0., 0.85), vec2(0., 0.62))); d = min(d, seg(p, vec2(0., 0.62), vec2(0.15, 0.5))); d = min(d, seg(p, vec2(0.15, 0.5), vec2(0.65, 0.5))); d = min(d, seg(p, vec2(0.65, 0.5), vec2(0.8, 0.38))); d = min(d, seg(p, vec2(0.8, 0.38), vec2(0.8, 0.15))); d = min(d, seg(p, vec2(0.8, 0.15), vec2(0.65, 0.))); d = min(d, seg(p, vec2(0.65, 0.), vec2(0.15, 0.))); d = min(d, seg(p, vec2(0.15, 0.), vec2(0., 0.15))); break; // S
    case 20: d = min(d, seg(p, vec2(0., 1.), vec2(0.8, 1.))); d = min(d, seg(p, vec2(0.4, 0.), vec2(0.4, 1.))); break; // T
    case 21: d = min(d, seg(p, vec2(0., 1.), vec2(0., 0.15))); d = min(d, seg(p, vec2(0., 0.15), vec2(0.15, 0.))); d = min(d, seg(p, vec2(0.15, 0.), vec2(0.65, 0.))); d = min(d, seg(p, vec2(0.65, 0.), vec2(0.8, 0.15))); d = min(d, seg(p, vec2(0.8, 0.15), vec2(0.8, 1.))); break; // U
    case 22: d = min(d, seg(p, vec2(0., 1.), vec2(0.4, 0.))); d = min(d, seg(p, vec2(0.4, 0.), vec2(0.8, 1.))); break; // V
    case 23: d = min(d, seg(p, vec2(0., 1.), vec2(0.2, 0.))); d = min(d, seg(p, vec2(0.2, 0.), vec2(0.4, 0.6))); d = min(d, seg(p, vec2(0.4, 0.6), vec2(0.6, 0.))); d = min(d, seg(p, vec2(0.6, 0.), vec2(0.8, 1.))); break; // W
    case 24: d = min(d, seg(p, vec2(0., 0.), vec2(0.8, 1.))); d = min(d, seg(p, vec2(0., 1.), vec2(0.8, 0.))); break; // X
    case 25: d = min(d, seg(p, vec2(0., 1.), vec2(0.4, 0.5))); d = min(d, seg(p, vec2(0.8, 1.), vec2(0.4, 0.5))); d = min(d, seg(p, vec2(0.4, 0.5), vec2(0.4, 0.))); break; // Y
    case 26: d = min(d, seg(p, vec2(0., 1.), vec2(0.8, 1.))); d = min(d, seg(p, vec2(0.8, 1.), vec2(0., 0.))); d = min(d, seg(p, vec2(0., 0.), vec2(0.8, 0.))); break; // Z
    case 27: d = min(d, seg(p, vec2(0.4, 0.), vec2(0.4, 0.03))); break; // .
    case 28: d = min(d, seg(p, vec2(0.15, 0.), vec2(0.65, 0.))); d = min(d, seg(p, vec2(0.65, 0.), vec2(0.8, 0.15))); d = min(d, seg(p, vec2(0.8, 0.15), vec2(0.8, 0.85))); d = min(d, seg(p, vec2(0.8, 0.85), vec2(0.65, 1.))); d = min(d, seg(p, vec2(0.65, 1.), vec2(0.15, 1.))); d = min(d, seg(p, vec2(0.15, 1.), vec2(0., 0.85))); d = min(d, seg(p, vec2(0., 0.85), vec2(0., 0.15))); d = min(d, seg(p, vec2(0., 0.15), vec2(0.15, 0.))); d = min(d, seg(p, vec2(0.3, 0.35), vec2(0.5, 0.65))); break; // 0
    case 29: d = min(d, seg(p, vec2(0.25, 0.8), vec2(0.45, 1.))); d = min(d, seg(p, vec2(0.45, 1.), vec2(0.45, 0.))); d = min(d, seg(p, vec2(0.2, 0.), vec2(0.7, 0.))); break; // 1
    case 30: d = min(d, seg(p, vec2(0., 0.85), vec2(0.15, 1.))); d = min(d, seg(p, vec2(0.15, 1.), vec2(0.65, 1.))); d = min(d, seg(p, vec2(0.65, 1.), vec2(0.8, 0.85))); d = min(d, seg(p, vec2(0.8, 0.85), vec2(0.8, 0.62))); d = min(d, seg(p, vec2(0.8, 0.62), vec2(0., 0.))); d = min(d, seg(p, vec2(0., 0.), vec2(0.8, 0.))); break; // 2
    case 31: d = min(d, seg(p, vec2(0., 1.), vec2(0.8, 1.))); d = min(d, seg(p, vec2(0.8, 1.), vec2(0.4, 0.55))); d = min(d, seg(p, vec2(0.4, 0.55), vec2(0.65, 0.55))); d = min(d, seg(p, vec2(0.65, 0.55), vec2(0.8, 0.4))); d = min(d, seg(p, vec2(0.8, 0.4), vec2(0.8, 0.15))); d = min(d, seg(p, vec2(0.8, 0.15), vec2(0.65, 0.))); d = min(d, seg(p, vec2(0.65, 0.), vec2(0.15, 0.))); d = min(d, seg(p, vec2(0.15, 0.), vec2(0., 0.15))); break; // 3
    case 32: d = min(d, seg(p, vec2(0.6, 0.), vec2(0.6, 1.))); d = min(d, seg(p, vec2(0.6, 1.), vec2(0., 0.3))); d = min(d, seg(p, vec2(0., 0.3), vec2(0.8, 0.3))); break; // 4
    case 33: d = min(d, seg(p, vec2(0.8, 1.), vec2(0., 1.))); d = min(d, seg(p, vec2(0., 1.), vec2(0., 0.55))); d = min(d, seg(p, vec2(0., 0.55), vec2(0.65, 0.55))); d = min(d, seg(p, vec2(0.65, 0.55), vec2(0.8, 0.4))); d = min(d, seg(p, vec2(0.8, 0.4), vec2(0.8, 0.15))); d = min(d, seg(p, vec2(0.8, 0.15), vec2(0.65, 0.))); d = min(d, seg(p, vec2(0.65, 0.), vec2(0.15, 0.))); d = min(d, seg(p, vec2(0.15, 0.), vec2(0., 0.15))); break; // 5
    case 34: d = min(d, seg(p, vec2(0.8, 0.85), vec2(0.65, 1.))); d = min(d, seg(p, vec2(0.65, 1.), vec2(0.15, 1.))); d = min(d, seg(p, vec2(0.15, 1.), vec2(0., 0.85))); d = min(d, seg(p, vec2(0., 0.85), vec2(0., 0.15))); d = min(d, seg(p, vec2(0., 0.15), vec2(0.15, 0.))); d = min(d, seg(p, vec2(0.15, 0.), vec2(0.65, 0.))); d = min(d, seg(p, vec2(0.65, 0.), vec2(0.8, 0.15))); d = min(d, seg(p, vec2(0.8, 0.15), vec2(0.8, 0.4))); d = min(d, seg(p, vec2(0.8, 0.4), vec2(0.65, 0.55))); d = min(d, seg(p, vec2(0.65, 0.55), vec2(0., 0.55))); break; // 6
    case 35: d = min(d, seg(p, vec2(0., 1.), vec2(0.8, 1.))); d = min(d, seg(p, vec2(0.8, 1.), vec2(0.3, 0.))); break; // 7
    case 36: d = min(d, seg(p, vec2(0.15, 1.), vec2(0.65, 1.))); d = min(d, seg(p, vec2(0.65, 1.), vec2(0.8, 0.85))); d = min(d, seg(p, vec2(0.8, 0.85), vec2(0.8, 0.65))); d = min(d, seg(p, vec2(0.8, 0.65), vec2(0.65, 0.52))); d = min(d, seg(p, vec2(0.65, 0.52), vec2(0.15, 0.52))); d = min(d, seg(p, vec2(0.15, 0.52), vec2(0., 0.65))); d = min(d, seg(p, vec2(0., 0.65), vec2(0., 0.85))); d = min(d, seg(p, vec2(0., 0.85), vec2(0.15, 1.))); d = min(d, seg(p, vec2(0.65, 0.52), vec2(0.8, 0.4))); d = min(d, seg(p, vec2(0.8, 0.4), vec2(0.8, 0.15))); d = min(d, seg(p, vec2(0.8, 0.15), vec2(0.65, 0.))); d = min(d, seg(p, vec2(0.65, 0.), vec2(0.15, 0.))); d = min(d, seg(p, vec2(0.15, 0.), vec2(0., 0.15))); d = min(d, seg(p, vec2(0., 0.15), vec2(0., 0.4))); d = min(d, seg(p, vec2(0., 0.4), vec2(0.15, 0.52))); break; // 8
    case 37: d = min(d, seg(p, vec2(0., 0.15), vec2(0.15, 0.))); d = min(d, seg(p, vec2(0.15, 0.), vec2(0.65, 0.))); d = min(d, seg(p, vec2(0.65, 0.), vec2(0.8, 0.15))); d = min(d, seg(p, vec2(0.8, 0.15), vec2(0.8, 0.85))); d = min(d, seg(p, vec2(0.8, 0.85), vec2(0.65, 1.))); d = min(d, seg(p, vec2(0.65, 1.), vec2(0.15, 1.))); d = min(d, seg(p, vec2(0.15, 1.), vec2(0., 0.85))); d = min(d, seg(p, vec2(0., 0.85), vec2(0., 0.6))); d = min(d, seg(p, vec2(0., 0.6), vec2(0.15, 0.45))); d = min(d, seg(p, vec2(0.15, 0.45), vec2(0.8, 0.45))); break; // 9
    case 38: d = min(d, seg(p, vec2(0.2, 0.5), vec2(0.6, 0.5))); break; // -
    case 39: d = min(d, seg(p, vec2(0.42, 0.05), vec2(0.32, -0.15))); break; // ,
    case 40: d = min(d, seg(p, vec2(0.4, 0.2), vec2(0.4, 0.23))); d = min(d, seg(p, vec2(0.4, 0.7), vec2(0.4, 0.73))); break; // :
    case 41: d = min(d, seg(p, vec2(0.1, 0.), vec2(0.7, 1.))); break; // /
    }
    return d;
}
// The card's lines, 1..26 = A..Z, 27 = full stop, 0 = space (28.. are digits and marks, for captions).
const int TXT[193] = int[193](
    5, 22, 5, 18, 25, 20, 8, 9, 14, 7, 0, 9, 14, 0, 20, 8, 9, 19, 0, 22, 9, 4, 5, 15, 0, 9, 19, 0, 1, 0,
    18, 5, 3, 15, 18, 4, 9, 14, 7, 0, 15, 6, 1, 0, 16, 18, 15, 3, 5, 4, 21, 18, 1, 12, 12, 25, 0, 7, 5, 14,
    5, 18, 1, 20, 5, 4, 0, 5, 14, 22, 9, 18, 15, 14, 13, 5, 14, 20, 23, 18, 9, 20, 20, 5, 14, 0, 9, 14, 0, 16,
    21, 18, 5, 0, 3, 0, 15, 14, 0, 12, 9, 14, 21, 24, 21, 19, 9, 14, 7, 0, 1, 0, 13, 15, 4, 5, 18, 14, 0, 14,
    22, 9, 4, 9, 1, 0, 18, 20, 24, 0, 3, 1, 18, 4, 13, 1, 20, 20, 0, 13, 9, 5, 18, 26, 23, 9, 14, 19, 11, 9,
    12, 5, 1, 18, 14, 0, 13, 15, 18, 5, 0, 1, 2, 15, 21, 20, 0, 13, 25, 0, 23, 15, 18, 11, 13, 1, 20, 20, 13, 9,
    5, 18, 26, 23, 9, 14, 19, 11, 9, 27, 3, 15, 13);
// One centred line of text at height y, letters h tall (both in screen heights).
float text(vec2 p, float y, float h, int off, int len) {
    vec2 q = (p - vec2(0., y)) / h + vec2(0., .5);
    if (abs(q.y - .5) > 1.2) return 0.;
    const float adv = 1.32;
    float x = q.x + (float(len) * adv - (adv - .8)) * .5, fi = floor(x / adv), d = 1e3;
    for (float i = fi - 1.; i < fi + 1.5; i++)
        if (i >= 0. && i < float(len)) d = min(d, letter(TXT[off + int(i)], vec2(x - i * adv, q.y)));
    return smoothstep(.055, .025, d) + .22 * exp(-d * 7.);
}
// QR code for https://mattmierzwinski.com, one row per entry, bit x = module x from the left.
const uint QR[29] = uint[29](533042047u,273774657u,391371613u,390748253u,390397533u,274105665u,534074751u,646144u,344484037u,416840989u,396136044u,45891200u,273786440u,417009577u,296319054u,10863785u,273709801u,484081318u,323653239u,3940772u,201310071u,387522304u,290941311u,421122113u,201224797u,254962269u,420004189u,43678273u,305391999u);

const float CARD = 12.5; // seconds the card owns before the picture starts to come up

// The card shown on black before anything else: what this is, who made it, where to find more.
vec3 card(vec2 uv, float ti) {
    float show = ease(.4, 1.8, ti) * (1. - ease(10.9, 12.2, ti));
    if (show <= 0.) return vec3(0.);
    vec2 p = (uv - .5) * vec2(uO.z, 1.);
    float v = 0.;
    v += text(p, 0.4, 0.03, 0, 42); // EVERYTHING IN THIS VIDEO IS A RECORDING OF
    v += text(p, 0.34, 0.03, 42, 36); // A PROCEDURALLY GENERATED ENVIRONMENT
    v += text(p, 0.28, 0.03, 78, 26); // WRITTEN IN PURE C ON LINUX
    v += text(p, 0.22, 0.03, 104, 30); // USING A MODERN NVIDIA RTX CARD
    v += text(p, 0.085, 0.052, 134, 16); // MATT MIERZWINSKI
    v += text(p, -0.005, 0.022, 150, 24); // LEARN MORE ABOUT MY WORK
    v += text(p, -0.415, 0.03, 174, 19); // MATTMIERZWINSKI.COM
    v += .5 * smoothstep(.0016, .0006, abs(p.y - .16)) * smoothstep(.62, .3, abs(p.x)); // hairline
    vec3 c = v * vec3(.80, .93, 1.);
    // the code sits on a light panel, dark on light, with its quiet zone, so phones read it
    vec2 g = (p - vec2(0., -.20)) / .30 + .5;
    if (g.x > 0. && g.x < 1. && g.y > 0. && g.y < 1.) {
        ivec2 m = ivec2(floor(g * 37.)) - 4;
        bool dark = m.x >= 0 && m.x < 29 && m.y >= 0 && m.y < 29 && ((QR[28 - m.y] >> uint(m.x)) & 1u) == 1u;
        c = dark ? vec3(.02, .03, .04) : vec3(.78, .86, .90);
    }
    return c * show;
}

// A small caption in one corner: rgb to screen over the picture, a = how much to dim behind it.
vec4 caption(vec2 uv) {
    if (uFI.x <= 0.) return vec4(0.);
    const float h = .0185, adv = 1.3, lh = 1.95, mg = .06; // letter height and margin in screen heights
    float asp = uO.z, W = uFI.z * adv * h, H = uFI.w * lh * h;
    bool right = mod(uFI.y, 2.) > .5, bottom = uFI.y > 1.5;
    vec2 q = (vec2(uv.x * asp, uv.y) - vec2(right ? asp - mg - W : mg, bottom ? mg + H : 1. - mg)) / h;
    float row = floor(-q.y / lh), fi = floor(q.x / adv), d = 1e3;
    if (row >= 0. && row < uFI.w)
        for (float i = fi - 1.; i < fi + 1.5; i++)
            if (i >= 0. && i < 40.) d = min(d, letter(uF[int(row) * 40 + int(i)], vec2(q.x - i * adv, 1.45 - (-q.y - row * lh))));
    float v = smoothstep(.085, .04, d) + .18 * exp(-d * 6.);
    // a thin bar beside the block, and a soft dark plate behind it so it reads over bright fog
    v += .8 * smoothstep(.08, .03, abs(q.x + 1.4)) * step(-uFI.w * lh, q.y) * step(q.y, 0.);
    vec2 e = max(abs(q - vec2(W / h * .5 - .7, -uFI.w * lh * .5)) - vec2(W / h * .5 + 1.4, uFI.w * lh * .5 + .6), 0.);
    return vec4(v * vec3(.80, .93, 1.), .55 * exp(-dot(e, e) * .25)) * uFI.x;
}

// Colour the title adds at this pixel, ti seconds after the card.
vec3 title(vec2 uv, float ti) {
    float show = ease(6.2, 7.8, ti) * (1. - ease(11.4, 13.4, ti));
    if (show <= 0.) return vec3(0.);
    vec2 p = (uv - .5) * vec2(uO.z, 1.) / .085;        // letter height: 8.5% of the screen
    float gap = .62 + .05 * (ti - 6.2) + .5 * ease(11.4, 13.4, ti); // spacing drifts apart, then lets go
    float half_w = (4.9 + 6. * gap) * .5;
    // letters are written on from the left, and dissolve with a flicker of scan lines
    float wipe = ease(0., .35, (ti - 6.2) * .9 - (p.x + half_w) / (2. * half_w) * .8);
    float scan = .86 + .14 * sin(uv.y * uA.y * 1.6 + ti * 9.);
    vec3 c = vec3(0.);
    for (int k = 0; k < 3; k++) { // slight colour fringe, as through a lens
        float d = word(p + vec2((float(k) - 1.) * .012, 0.), gap);
        float core = smoothstep(.034, .018, d), halo = .30 * exp(-d * 7.) + .10 * exp(-d * 2.2);
        c[k] = core + halo;
    }
    // hairlines above and below
    float rule = smoothstep(.012, .004, abs(abs(p.y) - 1.15)) * smoothstep(half_w * 1.05, half_w * .6, abs(p.x)) * .5;
    return (c * vec3(.80, .93, 1.) + rule * vec3(.5, .8, 1.)) * show * wipe * scan;
}

void main() {
    vec2 uv = (gl_FragCoord.xy - uI.zw) / uA.xy, cc = uv - .5;
    // Text is laid out on a 16:9 panel. Normally that is the frame; on a 180-degree frame it is a
    // panel straight ahead, about 92 by 52 degrees, nudged per eye so it floats in front of the scene.
    vec2 ouv = .5 + cc * uO.xy - vec2(uO.w, 0.);
    vec2 px = 1. / uA.xy;
    vec3 c = texture(T, uv).rgb;
    // restore the crispness temporal filtering costs, then add bloom
    vec3 nb = (texture(T, uv + vec2(px.x, 0.)).rgb + texture(T, uv - vec2(px.x, 0.)).rgb +
               texture(T, uv + vec2(0., px.y)).rgb + texture(T, uv - vec2(0., px.y)).rgb) * .25;
    c = max(c + (c - nb) * .45, 0.) + texture(B, uv).rgb * .035;
    c *= uI.x * uI.x;
    if (uA.w >= 0.) c *= pow(ease(CARD, CARD + 7., uA.w), 1.6); // after the card, the picture comes up out of black
    c *= 1. - 1.1 * dot(cc, cc) * step(uO.x, 1.5); // no vignette on a 180-degree frame
    // tone curve applied mostly to the brightest channel, so strong lights keep their hue
    float m = max(max(c.r, c.g), max(c.b, 1e-4));
    c = mix(aces(c), c / m * aces(vec3(m)).r, .6);
    // deepen the blacks, pull a little colour out of everything
    c = pow(c, vec3(1.12));
    c = mix(vec3(dot(c, vec3(.299, .587, .114))), c, .9);
    c = pow(c, vec3(1. / 2.2));
    if (uA.w >= 0.) c = 1. - (1. - c) * (1. - min(title(ouv, uA.w - CARD) + card(ouv, uA.w), 1.)); // screened over the picture
    vec4 cap = caption(ouv);
    c = 1. - (1. - c * (1. - cap.a)) * (1. - min(cap.rgb, 1.));
    c += (h21(gl_FragCoord.xy + fract(uA.z) * 311.) - .5) * .02;
    O = vec4(c, 1.);
}
