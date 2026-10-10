#version 330 core
// Temporal anti-aliasing and upsampling: the scene is rendered with a different sub-pixel
// offset every frame; this blends it into a full-resolution history reprojected from last frame.
out vec4 O;
uniform sampler2D C, H; // current scene (alpha = distance, see scene.frag), history
uniform vec4 uA;        // xy output resolution, zw scene resolution
uniform vec4 uJ;        // xy jitter in scene pixels, z history weight (0 resets)
uniform vec4 uL;        // x pixel aspect (< 0: 180-degree lens), y lens shift now, z lens shift last frame (see scene.frag uE)
uniform vec3 uRo, uRoP; // camera position now / last frame
uniform mat3 uM, uMP;   // camera basis now / last frame
uniform vec3 uDl;       // since last frame: station z advance, station spin, ship z advance

vec3 tm(vec3 c) { return c / (1. + max(c.r, max(c.g, c.b))); }
vec3 itm(vec3 c) { return c / (1. - min(max(c.r, max(c.g, c.b)), .985)); }

// Catmull-Rom history fetch, so repeated resampling does not blur the image
vec3 history(vec2 uv) {
    vec2 sz = uA.xy, sp = uv * sz, c = floor(sp - .5) + .5, f = sp - c;
    vec2 w0 = f * (-.5 + f * (1. - .5 * f)), w1 = 1. + f * f * (-2.5 + 1.5 * f);
    vec2 w2 = f * (.5 + f * (2. - 1.5 * f)), w3 = f * f * (-.5 + .5 * f);
    vec2 w12 = w1 + w2, t0 = (c - 1.) / sz, t3 = (c + 2.) / sz, t12 = (c + w2 / w12) / sz;
    vec3 r = texture(H, vec2(t0.x, t0.y)).rgb * w0.x * w0.y + texture(H, vec2(t12.x, t0.y)).rgb * w12.x * w0.y +
             texture(H, vec2(t3.x, t0.y)).rgb * w3.x * w0.y + texture(H, vec2(t0.x, t12.y)).rgb * w0.x * w12.y +
             texture(H, vec2(t12.x, t12.y)).rgb * w12.x * w12.y + texture(H, vec2(t3.x, t12.y)).rgb * w3.x * w12.y +
             texture(H, vec2(t0.x, t3.y)).rgb * w0.x * w3.y + texture(H, vec2(t12.x, t3.y)).rgb * w12.x * w3.y +
             texture(H, vec2(t3.x, t3.y)).rgb * w3.x * w3.y;
    return max(r, 0.);
}

void main() {
    vec2 uv = gl_FragCoord.xy / uA.xy, cuv = uv - uJ.xy / uA.zw;
    vec3 c = tm(texture(C, cuv).rgb);
    // colour statistics of the neighbourhood bound what the history may contribute
    vec3 m1 = vec3(0.), m2 = vec3(0.);
    for (int y = -1; y < 2; y++)
        for (int x = -1; x < 2; x++) {
            vec3 s = tm(texture(C, cuv + vec2(x, y) / uA.zw).rgb);
            m1 += s;
            m2 += s * s;
        }
    m1 /= 9.;
    vec3 sg = sqrt(max(m2 / 9. - m1 * m1, 0.)) * 1.3;

    // where was this surface point on screen last frame?
    float a = texelFetch(C, clamp(ivec2(cuv * uA.zw), ivec2(0), ivec2(uA.zw) - 1), 0).a, d = abs(a);
    vec2 fc = gl_FragCoord.xy * 2. - uA.xy, la = fc / uA.xy * 1.5707963;
    vec3 rd = uM * (uL.x < 0. ? vec3(sin(la.x) * cos(la.y), sin(la.y), cos(la.x) * cos(la.y))
                             : normalize(vec3(fc / uA.y * vec2(uL.x, 1.) + vec2(uL.y, 0.), 1.25)));
    vec3 P = uRo + rd * min(d, 1e4);
    if (a < 0.) P.z += uDl.z;
    else if (d < 5e3) {
        float cs = cos(uDl.y), sn = sin(uDl.y);
        P = vec3(cs * P.x - sn * P.y, sn * P.x + cs * P.y, P.z + uDl.x);
    }
    vec3 v = (P - uRoP) * uMP;
    vec3 vn = normalize(v);
    vec2 puv = uL.x < 0. ? vec2(atan(vn.x, vn.z), asin(clamp(vn.y, -1., 1.))) / 3.14159265 + .5
                         : ((v.xy / v.z * 1.25 - vec2(uL.z, 0.)) / vec2(uL.x, 1.) * uA.y + uA.xy) * .5 / uA.xy;
    float w = uJ.z;
    if (v.z <= 0. || any(lessThan(puv, vec2(0.))) || any(greaterThan(puv, vec2(1.)))) w = 0.;
    vec3 h = clamp(tm(history(puv)), m1 - sg, m1 + sg);
    O = vec4(itm(mix(c, h, w)), 1.);
}
