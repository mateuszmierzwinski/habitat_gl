// Habitat tube screensaver: Xlib + GLX host for a raymarched scene and its post chain.
#define _DEFAULT_SOURCE
#define GL_GLEXT_PROTOTYPES
#include "audio.h"
#include "facts.h"
#include <GL/gl.h>
#include <GL/glext.h>
#include <GL/glx.h>
#include <X11/Xatom.h>
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static const char scene_fs[] = {
#embed "scene.frag"
    , 0};
static const char taa_fs[] = {
#embed "taa.frag"
    , 0};
static const char bloom_fs[] = {
#embed "bloom.frag"
    , 0};
static const char post_fs[] = {
#embed "post.frag"
    , 0};
static const char quad_vs[] =
    "#version 330 core\n"
    "void main(){gl_Position=vec4(vec2(gl_VertexID&1,gl_VertexID>>1)*4.-1.,0.,1.);}";

// Must match the constants in scene.frag.
#define STATION_PERIOD 6144.0
#define SHIP_SPACING 800.0
#define SHIP_PERIOD (SHIP_SPACING * 64.0)
#define CAM_SPEED 2.0
#define SHIP_SPEED 2.5
#define SHIP_SCALE 1.25
#define SPIN_RATE 0.006
#define FOG_WIND 3.5       // fog banks drift towards the camera at this speed
#define FOG_PERIOD 4096.0  // a multiple of every tiling length the fog reads the noise at
#define BLOOM_LEVELS 6

typedef GLXContext (*CreateCtxFn)(Display *, GLXFBConfig, GLXContext, Bool, const int *);
typedef void (*SwapIntervalFn)(Display *, GLXDrawable, int);

static double now(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec * 1e-9;
}

static void die(const char *msg) {
    fprintf(stderr, "habitat: %s\n", msg);
    exit(1);
}

static GLuint compile(GLenum type, const char *src, const char *name) {
    GLuint s = glCreateShader(type);
    glShaderSource(s, 1, &src, NULL);
    glCompileShader(s);
    GLint ok;
    glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
    if (!ok) {
        char log[8192];
        glGetShaderInfoLog(s, sizeof log, NULL, log);
        fprintf(stderr, "%s:\n%s\n", name, log);
        exit(1);
    }
    return s;
}

static GLuint program(const char *fs, const char *name) {
    GLuint p = glCreateProgram();
    glAttachShader(p, compile(GL_VERTEX_SHADER, quad_vs, "quad.vert"));
    glAttachShader(p, compile(GL_FRAGMENT_SHADER, fs, name));
    glLinkProgram(p);
    GLint ok;
    glGetProgramiv(p, GL_LINK_STATUS, &ok);
    if (!ok) {
        char log[8192];
        glGetProgramInfoLog(p, sizeof log, NULL, log);
        fprintf(stderr, "%s link:\n%s\n", name, log);
        exit(1);
    }
    return p;
}

// A half-float colour target.
typedef struct { GLuint tex, fbo; int w, h; } Target;

static void target_size(Target *t, int w, int h) {
    if (w < 1) w = 1;
    if (h < 1) h = 1;
    if (!t->tex) {
        glGenTextures(1, &t->tex);
        glGenFramebuffers(1, &t->fbo);
    }
    if (t->w == w && t->h == h) return;
    t->w = w;
    t->h = h;
    glBindTexture(GL_TEXTURE_2D, t->tex);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA16F, w, h, 0, GL_RGBA, GL_HALF_FLOAT, NULL);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    glBindFramebuffer(GL_FRAMEBUFFER, t->fbo);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, t->tex, 0);
}

static void u4(GLuint p, const char *n, float a, float b, float c, float d) {
    glUniform4f(glGetUniformLocation(p, n), a, b, c, d);
}
static void utex(GLuint p, const char *n, int unit, GLuint tex) {
    glActiveTexture(GL_TEXTURE0 + unit);
    glBindTexture(GL_TEXTURE_2D, tex);
    glUniform1i(glGetUniformLocation(p, n), unit);
}
static void pass(GLuint fbo, int x, int w, int h) {
    glBindFramebuffer(GL_FRAMEBUFFER, fbo);
    glViewport(x, 0, w, h);
    glDrawArrays(GL_TRIANGLES, 0, 3);
}

static GLuint scene_prog, taa_prog, bloom_prog, post_prog, noise_tex;

// 64^3 tiling cloud noise: three octaves of value noise, each wrapping at the texture edge.
static void make_noise(void) {
    enum { N = 64 };
    static unsigned char lat[32 * 32 * 32], vox[N * N * N];
    unsigned s = 12345u;
    float amp = .5f, *acc = calloc(N * N * N, sizeof *acc);
    for (int cells = 8; cells <= 32; cells *= 2, amp *= .5f) {
        for (int i = 0; i < cells * cells * cells; i++) lat[i] = (s = s * 1664525u + 1013904223u) >> 24;
        for (int z = 0; z < N; z++)
            for (int y = 0; y < N; y++)
                for (int x = 0; x < N; x++) {
                    float f[3] = {x * cells / (float)N, y * cells / (float)N, z * cells / (float)N}, v = 0;
                    int i0[3];
                    for (int k = 0; k < 3; k++) i0[k] = (int)f[k], f[k] -= i0[k], f[k] = f[k] * f[k] * (3 - 2 * f[k]);
                    for (int c = 0; c < 8; c++) {
                        int ix = (i0[0] + (c & 1)) % cells, iy = (i0[1] + (c >> 1 & 1)) % cells, iz = (i0[2] + (c >> 2)) % cells;
                        v += lat[(iz * cells + iy) * cells + ix] * (c & 1 ? f[0] : 1 - f[0]) * (c & 2 ? f[1] : 1 - f[1]) * (c & 4 ? f[2] : 1 - f[2]);
                    }
                    acc[(z * N + y) * N + x] += v * amp;
                }
    }
    for (int i = 0; i < N * N * N; i++) vox[i] = (unsigned char)(acc[i] / .875f);
    free(acc);
    glGenTextures(1, &noise_tex);
    glBindTexture(GL_TEXTURE_3D, noise_tex);
    glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
    glTexImage3D(GL_TEXTURE_3D, 0, GL_R8, N, N, N, 0, GL_RED, GL_UNSIGNED_BYTE, vox);
    glTexParameteri(GL_TEXTURE_3D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_3D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
}
static Target scene, hist[2][2], bloom[BLOOM_LEVELS]; // hist[eye][ping-pong]

// What the temporal pass needs to remember about the previous frame.
typedef struct { float ro[3], m[9], shift; double station, ship, spin; } View;
static View prev[2];
static int stereo;                                  // side-by-side 3D: two eyes, each half the frame
static int vr180;                                   // each eye is a 180-degree view for a headset
static double stereo_ipd = 1.6, stereo_conv = 60.; // eye separation and the distance that sits at screen depth
static int frame, cur_hist;
static double intro_t = -1.; // seconds into the opening title, or negative for none

static double halton(int i, int b) {
    double f = 1., r = 0.;
    for (; i > 0; i /= b) r += (f /= b) * (i % b);
    return r;
}

static double wrap_delta(double a, double b, double period) {
    double d = a - b;
    return d < -period * .5 ? d + period : d > period * .5 ? d - period : d;
}

static double pmod(double x, double period) {
    x = fmod(x, period);
    return x < 0. ? x + period : x;
}

// The vec2 -> vec3 hash from scene.frag, so the host can find a ship the shader will draw.
static void hash23(float x, float y, float o[3]) {
    float q[3] = {x * .1031f, y * .1030f, x * .0973f};
    for (int i = 0; i < 3; i++) q[i] -= floorf(q[i]);
    float d = q[0] * (q[1] + 33.33f) + q[1] * (q[0] + 33.33f) + q[2] * (q[2] + 33.33f);
    for (int i = 0; i < 3; i++) q[i] += d;
    o[0] = (q[0] + q[1]) * q[2], o[1] = (q[0] + q[2]) * q[1], o[2] = (q[1] + q[2]) * q[0];
    for (int i = 0; i < 3; i++) o[i] -= floorf(o[i]);
}

// Which camera is live at time t: 0 station, 1 ship antenna, 2 drone. They take 30-second turns.
static int one_camera;
static int camera_at(double t) { return one_camera ? 0 : (int)(((long)floor(t / 30.)) % 3); }

// Drone 0 of a ship at wrapped time tw, in the ship frame. Mirrors dronePos() in scene.frag.
static void drone_pos(double slot, double L, double tw, double q[3]) {
    float h[3];
    hash23(1.f, (float)slot + 91.f, h);
    double a = 2. * M_PI * (h[1] + 8. * tw / 1024.);
    q[0] = (20. + 5. * h[2]) * cos(a), q[1] = (20. + 5. * h[2]) * sin(a);
    q[2] = L * .8 * sin(2. * M_PI * (h[0] + (3. + floor(h[1] * 4.)) * tw / 1024.));
}

// Sends the caption for video time vt to the post shader: one fact per minute, from 4 s to 18 s
// past the minute, in a corner picked by the minute number. Words are wrapped to 38 columns.
static int show_facts;
static void set_caption(GLuint prog, double vt) {
    long k = (long)floor(vt / 60.);
    double u = vt - k * 60., a = fmin(fmin((u - 4.) / 1.5, (18. - u) / 1.5), 1.);
    if (!show_facts || k < 1 || a <= 0.) {
        glUniform4f(glGetUniformLocation(prog, "uFI"), 0., 0., 0., 0.);
        return;
    }
    const char *s = facts[(k - 1) % (long)(sizeof facts / sizeof *facts)];
    int codes[200] = {0}, row = 0, col = 0, widest = 0;
    while (*s && row < 5) {
        int n = 0;
        while (s[n] && s[n] != ' ') n++;
        if (col && col + 1 + n > 38) row++, col = 0;
        else if (col) col++;
        for (int i = 0; i < n && row < 5 && col < 40; i++, col++) {
            static const char marks[] = ".0123456789-,:/";
            char ch = s[i];
            const char *m = strchr(marks, ch);
            codes[row * 40 + col] = ch >= 'A' && ch <= 'Z' ? ch - 'A' + 1 : m && ch ? 27 + (int)(m - marks) : 0;
        }
        if (col > widest) widest = col;
        s += n;
        while (*s == ' ') s++;
    }
    glUniform1iv(glGetUniformLocation(prog, "uF[0]"), 200, codes);
    glUniform4f(glGetUniformLocation(prog, "uFI"), a * a * (3. - 2. * a), (unsigned)(k * 2654435761u) >> 30, widest, row + 1);
}

// ---- MP4 tagging, so players and YouTube know a recording is 3D without being told.
// Adds the Spherical Video V2 boxes to the video track's sample entry: st3d (left-right stereo)
// and, for 180-degree recordings, sv3d (equirectangular, cropped to the front half-sphere).
// The file must have its moov box last, which is how ffmpeg writes it without +faststart;
// then growing moov moves no sample data and no offsets need fixing.
static uint32_t be32(const unsigned char *p) { return (uint32_t)p[0] << 24 | p[1] << 16 | p[2] << 8 | p[3]; }
static void put32(unsigned char *p, uint32_t v) { p[0] = v >> 24, p[1] = v >> 16, p[2] = v >> 8, p[3] = v; }

// Offset of the first child box of the given type inside [from, to), or -1.
static long mp4_find(const unsigned char *b, long from, long to, const char *type) {
    while (from + 8 <= to) {
        uint32_t sz = be32(b + from);
        if (sz < 8 || from + sz > to) return -1;
        if (!memcmp(b + from + 4, type, 4)) return from;
        from += sz;
    }
    return -1;
}

static int mp4_tag_3d(const char *path, int spherical180) {
    FILE *f = fopen(path, "r+b");
    if (!f) return -1;
    // top level: find moov and check nothing follows it
    unsigned char h[16];
    long off = 0, moov = -1, moov_sz = 0, end;
    fseek(f, 0, SEEK_END);
    end = ftell(f);
    while (off + 8 <= end) {
        fseek(f, off, SEEK_SET);
        if (fread(h, 1, 16, f) < 8) break;
        uint64_t sz = be32(h);
        if (sz == 1) sz = (uint64_t)be32(h + 8) << 32 | be32(h + 12);
        if (sz < 8) break;
        if (!memcmp(h + 4, "moov", 4)) moov = off, moov_sz = (long)sz;
        off += (long)sz;
    }
    if (moov < 0 || moov + moov_sz != end) return fclose(f), -2;

    // the boxes to add
    unsigned char add[128];
    int n = 0;
    put32(add + n, 13), memcpy(add + n + 4, "st3d", 4), put32(add + n + 8, 0), add[n + 12] = 2, n += 13; // 2 = left-right
    if (spherical180) {
        static const char src[] = "habitat";
        int svhd = 12 + (int)sizeof src, sv3d = 8 + svhd + 8 + 24 + 28;
        put32(add + n, sv3d), memcpy(add + n + 4, "sv3d", 4), n += 8;
        put32(add + n, svhd), memcpy(add + n + 4, "svhd", 4), put32(add + n + 8, 0), memcpy(add + n + 12, src, sizeof src), n += svhd;
        put32(add + n, 8 + 24 + 28), memcpy(add + n + 4, "proj", 4), n += 8;
        put32(add + n, 24), memcpy(add + n + 4, "prhd", 4), memset(add + n + 8, 0, 16), n += 24; // no yaw, pitch or roll
        put32(add + n, 28), memcpy(add + n + 4, "equi", 4), put32(add + n + 8, 0), n += 12;
        // bounds as fractions of the full sphere, 0.32 fixed point: top, bottom, left, right.
        // A quarter cut from each side leaves the front 180 degrees.
        put32(add + n, 0), put32(add + n + 4, 0), put32(add + n + 8, 0x3fffffff), put32(add + n + 12, 0x3fffffff), n += 16;
    }

    unsigned char *b = malloc(moov_sz + n);
    fseek(f, moov, SEEK_SET);
    if (!b || fread(b, 1, moov_sz, f) != (size_t)moov_sz) return fclose(f), -3;
    // walk moov / trak (the video one) / mdia / minf / stbl / stsd / first sample entry
    long path_off[7] = {0}, trak = 8, entry = -1;
    while ((trak = mp4_find(b, trak, moov_sz, "trak")) >= 0) {
        long te = trak + be32(b + trak), mdia = mp4_find(b, trak + 8, te, "mdia");
        long me = mdia < 0 ? 0 : mdia + be32(b + mdia), hdlr = mdia < 0 ? -1 : mp4_find(b, mdia + 8, me, "hdlr");
        if (hdlr >= 0 && !memcmp(b + hdlr + 16, "vide", 4)) {
            long minf = mp4_find(b, mdia + 8, me, "minf");
            long stbl = minf < 0 ? -1 : mp4_find(b, minf + 8, minf + be32(b + minf), "stbl");
            long stsd = stbl < 0 ? -1 : mp4_find(b, stbl + 8, stbl + be32(b + stbl), "stsd");
            if (stsd >= 0 && be32(b + stsd + 12) >= 1) {
                entry = stsd + 16;
                long p[7] = {0, trak, mdia, minf, stbl, stsd, entry};
                memcpy(path_off, p, sizeof p);
            }
            break;
        }
        trak = te;
    }
    if (entry < 0 || mp4_find(b, entry + 86, entry + be32(b + entry), "st3d") >= 0) return free(b), fclose(f), -4;

    // splice the boxes in at the end of the sample entry and grow every box that contains them
    long ins = entry + be32(b + entry);
    memmove(b + ins + n, b + ins, moov_sz - ins);
    memcpy(b + ins, add, n);
    for (int i = 0; i < 7; i++) put32(b + path_off[i], be32(b + path_off[i]) + n);
    fseek(f, moov, SEEK_SET);
    int ok = fwrite(b, 1, moov_sz + n, f) == (size_t)(moov_sz + n);
    free(b);
    return fclose(f) || !ok ? -5 : 0;
}

// How close the nearest ship is at time t, 0..1; drives the engine throb in the soundscape.
static double ship_prox(double t) {
    if (camera_at(t)) return camera_at(t) == 1 ? 1. : .7; // riding one, or circling it
    double zc = SHIP_SPACING * .5 - fmod(fmod(t * (CAM_SPEED + SHIP_SPEED), SHIP_PERIOD), SHIP_SPACING);
    return exp(-zc * zc / (170. * 170.));
}
static double rec_t0;
static double ship_prox_rec(double t) { return ship_prox(rec_t0 + t); }

// Renders one frame at time t into `target` (0 = window) of size w x h.
static void render(double t, double cycle, double scale, GLuint target, int w, int h) {
    int ew = stereo ? w / 2 : w; // one eye's share of the frame
    float pa = vr180 ? -1. : stereo ? 2. : 1.; // how much wider than tall its pixels are shown; < 0: 180-degree lens
    if (hist[0][0].w != ew || hist[0][0].h != h) frame = 0; // history is void after a resize
    target_size(&scene, (int)(ew * scale + .5), (int)(h * scale + .5));
    for (int i = 0; i < (stereo ? 4 : 2); i++) target_size(&hist[i / 2][i % 2], ew, h);
    for (int i = 0; i < BLOOM_LEVELS; i++) target_size(&bloom[i], ew >> (i + 1), h >> (i + 1));

    // Camera path is evaluated here in doubles so it never loses precision.
    // It drifts beside the axis, always looking ahead.
    // Three cameras, taking 30-second turns: one drifting beside the axis looking down the tube,
    // one on a ship's bow antenna, one on a drone circling that ship.
    // Everything is evaluated here in doubles so it never loses precision.
    int cam = camera_at(t);
    static int last_cam = -1;
    if (cam != last_cam) frame = 0, last_cam = cam; // a cut: the temporal history is void
    double zw, ro[3], fw[3], ur[3], dir = 1.; // zw: camera position along the station, unwrapped
    View v;
    v.spin = fmod(t * SPIN_RATE, 2. * M_PI);
    if (!cam) {
        zw = t * CAM_SPEED;
        v.ship = fmod(zw + t * SHIP_SPEED, SHIP_PERIOD);
        ro[0] = 28. + 3. * sin(t * .021), ro[1] = -46. + 3. * cos(t * .016), ro[2] = 0.;
        fw[0] = 10. + 8. * sin(t * .013 + 1.) - ro[0], fw[1] = -32. + 5. * sin(t * .0095) - ro[1], fw[2] = 110.;
        double roll = vr180 ? 0. : .06 * sin(t * .024); // in a headset the viewer does the looking around
        ur[0] = sin(roll), ur[1] = cos(roll), ur[2] = 0.;
    } else {
        // the ship just ahead of the station camera when this turn began; same hash as shipSlot() in scene.frag
        double t30 = floor(t / 30.) * 30., id = floor(t30 * (CAM_SPEED + SHIP_SPEED) / SHIP_SPACING) + 1.;
        float rn[3];
        hash23(fmod(id, 64.), 7., rn);
        double L = 70. + 50. * rn[0], roll = (rn[2] - .5) * 1.2, cr = cos(roll), sr = sin(roll);
        double q[3], d[3], u[3] = {0., 1., 0.}; // mount, view direction and up, in the ship frame
        if (cam == 1) {
            // on the tip of a bow antenna: ahead and down, swinging side to side; the hull is all behind
            q[0] = 1.6, q[1] = 0., q[2] = -L - 10.5;
            d[0] = .45 * sin(t * .07), d[1] = -.5 + .12 * sin(t * .045), d[2] = -.75;
            if (vr180) d[0] = 0., d[1] = -.2, d[2] = -1.; // steady and level: straight down the tunnel
        } else {
            // on a drone circling the ship: looking out at the wall and down the tunnel, never back at the ship
            drone_pos(fmod(id, 64.), L, fmod(t, 1024.), q);
            double ol = sqrt(q[0] * q[0] + q[1] * q[1]), ox = q[0] / ol, oy = q[1] / ol;
            double out = .55 + .15 * sin(t * .05);
            d[0] = ox * out, d[1] = oy * out, d[2] = -.8;
            u[0] = -ox, u[1] = -oy; // the ship is "up", so the wall sits below
            if (vr180) d[0] = ox * .2, d[1] = oy * .2, d[2] = -1., u[0] = 0., u[1] = 1.; // no rolling horizon
        }
        double zs = (id + .5) * SHIP_SPACING + q[2] * SHIP_SCALE;
        zw = zs - t * SHIP_SPEED;
        v.ship = fmod(zs, SHIP_PERIOD);
        // ship frame -> world: undo the roll, scale, add the ship's offset from the axis
        ro[0] = (cr * q[0] + sr * q[1]) * SHIP_SCALE + (rn[1] - .5) * 16.;
        ro[1] = (-sr * q[0] + cr * q[1]) * SHIP_SCALE + (rn[2] - .5) * 8.;
        ro[2] = 0.;
        fw[0] = cr * d[0] + sr * d[1], fw[1] = -sr * d[0] + cr * d[1], fw[2] = d[2];
        ur[0] = cr * u[0] + sr * u[1], ur[1] = -sr * u[0] + cr * u[1], ur[2] = 0.;
        dir = -1.; // ships fly the other way down the tube
    }
    v.station = pmod(zw, STATION_PERIOD);
    audio_ship = ship_prox(t);
    double fl = sqrt(fw[0] * fw[0] + fw[1] * fw[1] + fw[2] * fw[2]);
    for (int i = 0; i < 3; i++) fw[i] /= fl;
    double rt[3] = {ur[1] * fw[2] - ur[2] * fw[1], ur[2] * fw[0] - ur[0] * fw[2], ur[0] * fw[1] - ur[1] * fw[0]};
    double rl = sqrt(rt[0] * rt[0] + rt[1] * rt[1] + rt[2] * rt[2]);
    for (int i = 0; i < 3; i++) rt[i] /= rl;
    double up[3] = {fw[1] * rt[2] - fw[2] * rt[1], fw[2] * rt[0] - fw[0] * rt[2], fw[0] * rt[1] - fw[1] * rt[0]};
    for (int i = 0; i < 3; i++) v.ro[i] = ro[i], v.m[i] = rt[i], v.m[3 + i] = up[i], v.m[6 + i] = fw[i];
    v.shift = 0.;
    float tw = fmod(t, 2000. * M_PI);
    float jx = halton(frame % 16 + 1, 2) - .5, jy = halton(frame % 16 + 1, 3) - .5;
    double cut = fmod(t, 30.), dip = fmin(fmin(cut, 30. - cut) / .7, 1.); // dip to black across a camera change

    // One pass per eye. In stereo the frame is split left | right, each eye squeezed to half width
    // (pixel aspect 2). The right eye is the camera as computed; the left sits `stereo_ipd` to its
    // left. Both look straight ahead with the lens shifted so their views meet at `stereo_conv`.
    for (int eye = 0; eye < (stereo ? 2 : 1); eye++) {
        View e = v;
        double ex = stereo && !eye ? -stereo_ipd : 0.;
        for (int i = 0; i < 3; i++) e.ro[i] += rt[i] * ex;
        e.shift = stereo && !vr180 ? (eye ? -1. : 1.) * .5 * stereo_ipd * 1.25 / stereo_conv : 0.; // 180: eyes parallel
        if (!frame) prev[eye] = e;
        View *pv = &prev[eye];

        glDisable(GL_BLEND);
        glUseProgram(scene_prog);
        u4(scene_prog, "uA", scene.w, scene.h, tw, fmod(t / cycle, 1.));
        u4(scene_prog, "uB", e.station, e.ship, e.spin, pmod(zw + t * FOG_WIND, FOG_PERIOD));
        glActiveTexture(GL_TEXTURE2);
        glBindTexture(GL_TEXTURE_3D, noise_tex);
        glUniform1i(glGetUniformLocation(scene_prog, "uN"), 2);
        u4(scene_prog, "uC", e.ro[0], e.ro[1], e.ro[2], dir);
        u4(scene_prog, "uD", 0., 0., 0., fmod(t, 1024.));
        u4(scene_prog, "uE", jx, jy, pa, e.shift);
        glUniformMatrix3fv(glGetUniformLocation(scene_prog, "uM"), 1, GL_FALSE, e.m);
        pass(scene.fbo, 0, scene.w, scene.h);

        // temporal resolve into full-resolution history
        Target *out = &hist[eye][cur_hist], *old = &hist[eye][!cur_hist];
        glUseProgram(taa_prog);
        utex(taa_prog, "C", 0, scene.tex);
        utex(taa_prog, "H", 1, old->tex);
        u4(taa_prog, "uA", ew, h, scene.w, scene.h);
        u4(taa_prog, "uJ", jx, jy, frame ? .9 : 0., 0.);
        u4(taa_prog, "uL", pa, e.shift, pv->shift, 0.);
        glUniform3fv(glGetUniformLocation(taa_prog, "uRo"), 1, e.ro);
        glUniform3fv(glGetUniformLocation(taa_prog, "uRoP"), 1, pv->ro);
        glUniformMatrix3fv(glGetUniformLocation(taa_prog, "uM"), 1, GL_FALSE, e.m);
        glUniformMatrix3fv(glGetUniformLocation(taa_prog, "uMP"), 1, GL_FALSE, pv->m);
        glUniform3f(glGetUniformLocation(taa_prog, "uDl"), wrap_delta(e.station, pv->station, STATION_PERIOD),
                    wrap_delta(e.spin, pv->spin, 2. * M_PI), wrap_delta(e.ship, pv->ship, SHIP_PERIOD));
        pass(out->fbo, 0, ew, h);

        // bloom pyramid: halve down, then add each level back into the one above
        glUseProgram(bloom_prog);
        for (int i = 0; i < BLOOM_LEVELS; i++) {
            utex(bloom_prog, "T", 0, i ? bloom[i - 1].tex : out->tex);
            u4(bloom_prog, "uA", bloom[i].w, bloom[i].h, 0., 1.);
            pass(bloom[i].fbo, 0, bloom[i].w, bloom[i].h);
        }
        glEnable(GL_BLEND);
        glBlendFunc(GL_ONE, GL_ONE);
        for (int i = BLOOM_LEVELS - 2; i >= 0; i--) {
            utex(bloom_prog, "T", 0, bloom[i + 1].tex);
            u4(bloom_prog, "uA", bloom[i].w, bloom[i].h, 1., .8);
            pass(bloom[i].fbo, 0, bloom[i].w, bloom[i].h);
        }
        glDisable(GL_BLEND);

        glUseProgram(post_prog);
        utex(post_prog, "T", 0, out->tex);
        utex(post_prog, "B", 1, bloom[0].tex);
        u4(post_prog, "uA", ew, h, tw, intro_t);
        u4(post_prog, "uI", t < 1. || one_camera ? 1. : dip * dip * (3. - 2. * dip), pa, eye * ew, 0.);
        if (vr180) u4(post_prog, "uO", 1.947, 3.46, 16. / 9., (eye ? -.5 : .5) * stereo_ipd / 40. / M_PI); // text 40 units away
        else u4(post_prog, "uO", 1., 1., ew * pa / h, 0.);
        set_caption(post_prog, intro_t >= 0. ? intro_t : t);
        pass(target, eye * ew, ew, h);
        prev[eye] = e;
    }

    cur_hist = !cur_hist;
    frame++;
}

static void usage(void) {
    puts("usage: habitat [options]\n"
         "  (no options)        fullscreen, playing as a film: opening, three cameras, captions;\n"
         "                      any key, click or mouse move quits\n"
         "  -hold               ignore the mouse and keyboard, only Esc or q quits\n"
         "  -stereo             side-by-side 3D: left and right eye, each squeezed into half the frame\n"
         "  -stereo180          3D for a headset: each eye a 180-degree view (longitude-latitude), side by side;\n"
         "                      recordings are tagged as VR180 for YouTube and players\n"
         "  -ipd F              eye separation for the 3D modes in scene units, default 1.6\n"
         "  -window             1280x720 window; Esc or q quits\n"
         "  -root               draw on the root window\n"
         "  -window-id ID       draw inside an existing window (also $XSCREENSAVER_WINDOW)\n"
         "  -mute               no sound\n"
         "  -volume F           sound level, default 0.7\n"
         "  -scale F            maximum internal render scale, default 1.0\n"
         "  -budget MS          GPU time per frame to hold by lowering the scale, default 14.5\n"
         "  -cycle SEC          seconds for a full colour cycle, default 360\n"
         "  -t SEC              start time offset\n"
         "  -fps                print frame times\n"
         "  -size WxH           size for -window / -shot / -bench / -record\n"
         "                      (-record defaults to 1920x1080, 3840x2160 for -stereo, 4320x2160 for -stereo180)\n"
         "  -shot FILE.ppm      render one frame offscreen and exit\n"
         "  -bench N            time N offscreen frames and exit\n"
         "  -wav FILE SEC       write SEC seconds of the soundscape to a WAV file and exit\n"
         "  -record FILE SEC    render SEC seconds, picture and sound, to an MP4 (needs ffmpeg) and exit\n"
         "  -no-intro           skip the opening card, fade and title\n"
         "  -no-facts           no caption about the project each minute (text is in facts.h)\n"
         "  -no-cams            stay on the station camera instead of taking turns with the ship and drone\n"
         "  -plain              all three of the above: just the endless flight\n"
         "  -intro / -facts     turn those on for -shot and -bench, where they are off\n"
         "  -rfps N             frame rate for -record, default 30, or 60 for -stereo180\n"
         "  -crf N              x264 quality for -record, lower is better, default 20");
}

int main(int argc, char **argv) {
    double scale = 1., cycle = 360., t0 = 0., budget = 14.5, volume = .7, wav_secs = 0.;
    int windowed = 0, show_fps = 0, bench = 0, hold = 0, mute = 0, w = 0, h = 0;
    const char *shot = NULL, *wav = NULL, *record = NULL;
    double rec_secs = 0.;
    int rfps = 0, crf = 20, intro = -1;
    Window parent = 0;
    int use_root = 0;

    const char *env = getenv("XSCREENSAVER_WINDOW");
    if (env && *env) parent = strtoul(env, NULL, 0);
    for (int i = 1; i < argc; i++) {
        const char *a = argv[i], *v = i + 1 < argc ? argv[i + 1] : NULL;
        if (!strcmp(a, "-window")) windowed = 1;
        else if (!strcmp(a, "-root")) use_root = 1;
        else if (!strcmp(a, "-fps")) show_fps = 1;
        else if (!strcmp(a, "-hold")) hold = 1;
        else if (!strcmp(a, "-stereo")) stereo = 1;
        else if (!strcmp(a, "-stereo180") || !strcmp(a, "-vr180")) stereo = vr180 = 1;
        else if (!strcmp(a, "-ipd") && v) stereo_ipd = atof(v), i++;
        else if (!strcmp(a, "-mute")) mute = 1;
        else if (!strcmp(a, "-window-id") && v) parent = strtoul(v, NULL, 0), i++;
        else if (!strcmp(a, "-scale") && v) scale = atof(v), i++;
        else if (!strcmp(a, "-cycle") && v) cycle = atof(v), i++;
        else if (!strcmp(a, "-budget") && v) budget = atof(v), i++;
        else if (!strcmp(a, "-volume") && v) volume = atof(v), i++;
        else if (!strcmp(a, "-t") && v) t0 = atof(v), i++;
        else if (!strcmp(a, "-shot") && v) shot = v, i++;
        else if (!strcmp(a, "-bench") && v) bench = atoi(v), i++;
        else if (!strcmp(a, "-wav") && v && i + 2 < argc) wav = v, wav_secs = atof(argv[i + 2]), i += 2;
        else if (!strcmp(a, "-record") && v && i + 2 < argc) record = v, rec_secs = atof(argv[i + 2]), i += 2;
        else if (!strcmp(a, "-rfps") && v) rfps = atoi(v), i++;
        else if (!strcmp(a, "-intro")) intro = 1;
        else if (!strcmp(a, "-no-intro")) intro = 0;
        else if (!strcmp(a, "-facts")) show_facts = 1;
        else if (!strcmp(a, "-no-facts")) show_facts = -1;
        else if (!strcmp(a, "-no-cams")) one_camera = 1;
        else if (!strcmp(a, "-plain")) intro = 0, show_facts = -1, one_camera = 1;
        else if (!strcmp(a, "-crf") && v) crf = atoi(v), i++;
        else if (!strcmp(a, "-size") && v && sscanf(v, "%dx%d", &w, &h) == 2) i++;
        else { usage(); return strcmp(a, "-h") && strcmp(a, "--help"); }
    }
    rec_t0 = t0;
    if (wav) return audio_wav(wav, wav_secs, volume, ship_prox_rec) ? (perror(wav), 1) : 0;
    if (!rfps) rfps = vr180 ? 60 : 30; // a headset shows 30 as judder
    if (record && (rfps < 1 || rec_secs <= 0.)) die("-record needs a positive length and frame rate");
    if (scale < .1) scale = .1;
    if (scale > 2.) scale = 2.;
    if (cycle < 1.) cycle = 1.;
    int offscreen = shot || bench || record;
    if (!w) { // no -size given
        if (record) w = vr180 ? 4320 : stereo ? 3840 : 1920, h = stereo ? 2160 : 1080; // 180: 2160 x 2160 an eye
        else w = 1280, h = 720;
    }
    int film = !shot && !bench; // live and recorded runs play as a film unless told otherwise
    if (intro < 0) intro = film;
    show_facts = show_facts ? show_facts > 0 : film;

    Display *dpy = XOpenDisplay(NULL);
    if (!dpy) die("cannot open display");
    int scr = DefaultScreen(dpy);
    if (use_root) parent = RootWindow(dpy, scr);
    int embedded = parent != 0;

    static const int fb_attr[] = {GLX_X_RENDERABLE, True, GLX_DRAWABLE_TYPE, GLX_WINDOW_BIT,
                                  GLX_RENDER_TYPE, GLX_RGBA_BIT, GLX_RED_SIZE, 8, GLX_GREEN_SIZE, 8,
                                  GLX_BLUE_SIZE, 8, GLX_DOUBLEBUFFER, True, None};
    int nfb;
    GLXFBConfig *fbs = glXChooseFBConfig(dpy, scr, fb_attr, &nfb);
    if (!fbs || !nfb) die("no suitable GLX framebuffer config");
    GLXFBConfig fb = fbs[0];
    XVisualInfo *vi = glXGetVisualFromFBConfig(dpy, fb);
    if (!vi) die("no visual");

    if (embedded) {
        XWindowAttributes pa;
        if (!XGetWindowAttributes(dpy, parent, &pa)) die("bad window id");
        w = pa.width;
        h = pa.height;
    } else if (!windowed && !offscreen) {
        w = DisplayWidth(dpy, scr);
        h = DisplayHeight(dpy, scr);
    }

    // Always our own window (a child when embedded) so the visual is ours to pick.
    XSetWindowAttributes swa = {0};
    swa.colormap = XCreateColormap(dpy, RootWindow(dpy, scr), vi->visual, AllocNone);
    swa.event_mask = embedded ? 0 : KeyPressMask | ButtonPressMask | PointerMotionMask | StructureNotifyMask;
    Window win = XCreateWindow(dpy, embedded ? parent : RootWindow(dpy, scr), 0, 0, w, h, 0, vi->depth,
                               InputOutput, vi->visual, CWColormap | CWEventMask | CWBorderPixel | CWBackPixel, &swa);
    Atom wm_delete = XInternAtom(dpy, "WM_DELETE_WINDOW", False);
    if (!embedded) {
        XStoreName(dpy, win, "habitat");
        XSetWMProtocols(dpy, win, &wm_delete, 1);
        if (!windowed) {
            Atom fs = XInternAtom(dpy, "_NET_WM_STATE_FULLSCREEN", False);
            XChangeProperty(dpy, win, XInternAtom(dpy, "_NET_WM_STATE", False), XA_ATOM, 32, PropModeReplace,
                            (unsigned char *)&fs, 1);
            char none[1] = {0};
            XColor black = {0};
            Pixmap pm = XCreateBitmapFromData(dpy, win, none, 1, 1);
            XDefineCursor(dpy, win, XCreatePixmapCursor(dpy, pm, pm, &black, &black, 0, 0));
        }
    }

    CreateCtxFn create_ctx = (CreateCtxFn)glXGetProcAddressARB((const GLubyte *)"glXCreateContextAttribsARB");
    if (!create_ctx) die("GLX_ARB_create_context missing");
    static const int ctx_attr[] = {GLX_CONTEXT_MAJOR_VERSION_ARB, 3, GLX_CONTEXT_MINOR_VERSION_ARB, 3,
                                   GLX_CONTEXT_PROFILE_MASK_ARB, GLX_CONTEXT_CORE_PROFILE_BIT_ARB, None};
    GLXContext ctx = create_ctx(dpy, fb, NULL, True, ctx_attr);
    if (!ctx) die("cannot create OpenGL 3.3 context");
    if (!offscreen) XMapRaised(dpy, win);
    glXMakeCurrent(dpy, win, ctx);
    SwapIntervalFn swap_interval = (SwapIntervalFn)glXGetProcAddressARB((const GLubyte *)"glXSwapIntervalEXT");
    if (swap_interval) swap_interval(dpy, win, 1);

    GLuint vao;
    glGenVertexArrays(1, &vao);
    glBindVertexArray(vao);
    scene_prog = program(scene_fs, "scene.frag");
    taa_prog = program(taa_fs, "taa.frag");
    bloom_prog = program(bloom_fs, "bloom.frag");
    post_prog = program(post_fs, "post.frag");
    make_noise();

    if (offscreen) {
        GLuint out_tex, out_fbo;
        glGenTextures(1, &out_tex);
        glBindTexture(GL_TEXTURE_2D, out_tex);
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
        glGenFramebuffers(1, &out_fbo);
        glBindFramebuffer(GL_FRAMEBUFFER, out_fbo);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, out_tex, 0);
        if (bench) {
            render(t0, cycle, scale, out_fbo, w, h);
            glFinish();
            double s = now();
            for (int i = 0; i < bench; i++) render(t0 + i / 60., cycle, scale, out_fbo, w, h);
            glFinish();
            double ms = (now() - s) * 1000. / bench;
            printf("%dx%d scale %.2f: %.2f ms/frame (%.0f fps)\n", w, h, scale, ms, 1000. / ms);
        }
        if (record) {
            // Sound first (it is quick), then frames piped to ffmpeg, which muxes the two.
            char tmp[4096], cmd[8192];
            snprintf(tmp, sizeof tmp, "%s.audio.wav", record);
            if (audio_wav(tmp, rec_secs, volume, ship_prox_rec)) die("cannot write the temporary audio file");
            snprintf(cmd, sizeof cmd,
                     "ffmpeg -hide_banner -loglevel error -y -f rawvideo -pix_fmt rgb24 -s %dx%d -r %d -i - -i '%s' "
                     "-vf vflip -c:v libx264 -preset medium -crf %d %s-pix_fmt yuv420p -c:a aac -b:a 192k "
                     "-shortest %s'%s'", w, h, rfps, tmp, crf,
                     stereo ? "-x264-params frame-packing=3 " : "", // 3 = side by side, left eye first
                     stereo ? "" : "-movflags +faststart ",         // 3D files keep moov last, for mp4_tag_3d
                     record);
            FILE *ff = popen(cmd, "w");
            if (!ff) die("cannot start ffmpeg");
            long total = (long)(rec_secs * rfps + .5);
            unsigned char *px = malloc((size_t)w * h * 3);
            glPixelStorei(GL_PACK_ALIGNMENT, 1);
            frame = 0;
            if (intro) intro_t = 0.;
            for (int i = 30; i > 0; i--) render(t0 - i / (double)rfps, cycle, scale, out_fbo, w, h); // settle the history
            double s = now();
            for (long i = 0; i < total; i++) {
                if (intro) intro_t = i / (double)rfps;
                render(t0 + i / (double)rfps, cycle, scale, out_fbo, w, h);
                glBindFramebuffer(GL_FRAMEBUFFER, out_fbo);
                glReadPixels(0, 0, w, h, GL_RGB, GL_UNSIGNED_BYTE, px);
                if (fwrite(px, 3, (size_t)w * h, ff) != (size_t)w * h) die("ffmpeg stopped accepting frames");
                if (i % (rfps * 10) == 0 || i == total - 1) {
                    double el = now() - s, eta = i ? el / i * (total - i) : 0.;
                    fprintf(stderr, "\r%ld / %ld frames, %.0f s elapsed, about %.0f min left   ", i + 1, total, el, eta / 60.);
                }
            }
            fprintf(stderr, "\n");
            free(px);
            int rc = pclose(ff);
            remove(tmp);
            if (rc) die("ffmpeg failed");
            if (stereo && mp4_tag_3d(record, vr180)) die("recorded, but could not write the 3D tag into the file");
        }
        if (shot) {
            // run the half second leading up to t0 so the temporal accumulation has settled
            frame = 0;
            if (intro) intro_t = t0; // with -intro, a still shows the opening at time t0
            for (int i = 30; i >= 0; i--) render(t0 - i / 60., cycle, scale, out_fbo, w, h);
            unsigned char *px = malloc((size_t)w * h * 3);
            glBindFramebuffer(GL_FRAMEBUFFER, out_fbo);
            glPixelStorei(GL_PACK_ALIGNMENT, 1);
            glReadPixels(0, 0, w, h, GL_RGB, GL_UNSIGNED_BYTE, px);
            FILE *f = fopen(shot, "wb");
            if (!f) die("cannot write screenshot");
            fprintf(f, "P6\n%d %d\n255\n", w, h);
            for (int y = h - 1; y >= 0; y--) fwrite(px + (size_t)y * w * 3, 3, w, f);
            fclose(f);
            free(px);
        }
        return 0;
    }

    if (!mute) audio_start(volume);

    // Dynamic resolution: time each frame on the GPU and step the render scale to hold the budget.
    GLuint timer;
    glGenQueries(1, &timer);
    double cur = scale, gpu_ms = budget * .8;
    int timing = 0, settle = 0;

    double start = now(), fps_t = start;
    int frames = 0, moved = 0, mx = -1, my = -1, running = 1;
    int any_input = !windowed && !hold; // otherwise only Esc / q quit
    while (running) {
        while (XPending(dpy)) {
            XEvent e;
            XNextEvent(dpy, &e);
            switch (e.type) {
            case ConfigureNotify:
                w = e.xconfigure.width;
                h = e.xconfigure.height;
                break;
            case ClientMessage:
                if ((Atom)e.xclient.data.l[0] == wm_delete) running = 0;
                break;
            case KeyPress: {
                KeySym k = XLookupKeysym(&e.xkey, 0);
                if (any_input || k == XK_Escape || k == XK_q) running = 0;
                break;
            }
            case ButtonPress:
                if (any_input) running = 0;
                break;
            case MotionNotify:
                // ignore the pointer settling right after the window appears
                if (any_input && now() - start > 1.) {
                    if (mx >= 0) moved += abs(e.xmotion.x_root - mx) + abs(e.xmotion.y_root - my);
                    mx = e.xmotion.x_root;
                    my = e.xmotion.y_root;
                    if (moved > 24) running = 0;
                }
                break;
            }
        }
        if (embedded) { // follow the host window; we get no events for it
            Window r;
            int x, y;
            unsigned pw, ph, bw, dp;
            if (!XGetGeometry(dpy, parent, &r, &x, &y, &pw, &ph, &bw, &dp)) break;
            if ((int)pw != w || (int)ph != h) XResizeWindow(dpy, win, w = pw, h = ph);
        }
        if (timing) {
            GLuint64 ns;
            glGetQueryObjectui64v(timer, GL_QUERY_RESULT, &ns);
            gpu_ms += (ns * 1e-6 - gpu_ms) * .15;
            if (++settle > 20) {
                if (gpu_ms > budget && cur > scale * .6) cur -= .05, settle = 0, gpu_ms *= .9;
                else if (gpu_ms < budget * .8 && cur < scale - .01) cur += .05, settle = 0, gpu_ms *= 1.1;
            }
        }
        glBeginQuery(GL_TIME_ELAPSED, timer);
        if (intro) intro_t = now() - start;
        render(t0 + now() - start, cycle, cur, 0, w, h);
        glEndQuery(GL_TIME_ELAPSED);
        timing = 1;
        glXSwapBuffers(dpy, win);
        frames++;
        if (show_fps && now() - fps_t >= 2.) {
            printf("%dx%d: %.2f ms/frame, gpu %.2f ms, scale %.2f\n", w, h, (now() - fps_t) * 1000. / frames, gpu_ms, cur);
            fflush(stdout);
            fps_t = now();
            frames = 0;
        }
    }
    glXMakeCurrent(dpy, None, NULL);
    glXDestroyContext(dpy, ctx);
    XCloseDisplay(dpy);
    return 0;
}
