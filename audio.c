// Procedural soundscape: a low drone and rumble, wind-like tonal bands, and a city heard
// from very far away, all through a long reverb. Nothing is sampled; it never repeats.
#include "audio.h"
#include <alsa/asoundlib.h>
#include <math.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define SR 48000
#define TAU 6.283185307179586

volatile float audio_ship; // 0..1, how close a ship is; set by the render loop

static uint32_t rng = 0x9e3779b9u;
static float rnd(void) { // uniform in [-1, 1]
    rng ^= rng << 13;
    rng ^= rng >> 17;
    rng ^= rng << 5;
    return (int32_t)rng * (1.f / 2147483648.f);
}
static float rnd01(void) { return rnd() * .5f + .5f; }

typedef struct { float b0, b1, b2, a1, a2, z1, z2; } Biquad;
static float bq(Biquad *f, float x) {
    float y = f->b0 * x + f->z1;
    f->z1 = f->b1 * x - f->a1 * y + f->z2;
    f->z2 = f->b2 * x - f->a2 * y;
    return y;
}
static void bq_set(Biquad *f, int band, float hz, float q) {
    float w = TAU * hz / SR, c = cosf(w), al = sinf(w) / (2 * q), a0 = 1 + al;
    if (band) f->b0 = al / a0, f->b1 = 0, f->b2 = -al / a0;
    else f->b0 = f->b2 = (1 - c) / 2 / a0, f->b1 = (1 - c) / a0;
    f->a1 = -2 * c / a0;
    f->a2 = (1 - al) / a0;
}

// A value that wanders: picks a new random target every few seconds and eases towards it.
typedef struct { float v, to; int left; float lo, hi, secs; } Drift;
static float drift(Drift *d) {
    if (--d->left <= 0) {
        d->to = d->lo + (d->hi - d->lo) * rnd01();
        d->left = (int)(SR * d->secs * (.5f + rnd01()));
    }
    d->v += (d->to - d->v) * (2.5f / (SR * d->secs));
    return d->v;
}

// --- reverb: four damped combs and two allpasses per channel, about seven seconds of tail
#define NCOMB 4
static const int comb_len[2][NCOMB] = {{1687, 1933, 2251, 2539}, {1741, 1997, 2311, 2617}};
static const int ap_len[2][2] = {{347, 113}, {359, 127}};
static float comb_buf[2][NCOMB][2700], comb_lp[2][NCOMB], ap_buf[2][2][400];
static int comb_i[2][NCOMB], ap_i[2][2];

static float reverb(int ch, float x) {
    float out = 0;
    for (int k = 0; k < NCOMB; k++) {
        int n = comb_len[ch][k], *i = &comb_i[ch][k];
        float y = comb_buf[ch][k][*i];
        comb_lp[ch][k] = y * .62f + comb_lp[ch][k] * .38f;
        comb_buf[ch][k][*i] = x + comb_lp[ch][k] * powf(10.f, -3.f * n / (7.f * SR));
        *i = (*i + 1) % n;
        out += y;
    }
    for (int k = 0; k < 2; k++) {
        int n = ap_len[ch][k], *i = &ap_i[ch][k];
        float b = ap_buf[ch][k][*i], y = b - out * .6f;
        ap_buf[ch][k][*i] = out + b * .6f;
        *i = (*i + 1) % n;
        out = y;
    }
    return out * .25f;
}

// --- voices
#define NDRONE 5
static const float drone_hz[NDRONE] = {27.5f, 36.71f, 55.f, 73.6f, 110.3f};
static const float drone_amp[NDRONE] = {.30f, .42f, .30f, .16f, .07f};
static double drone_ph[NDRONE], lfo_t;

#define NPAD 8
static const float pad_hz[NPAD] = {293.7f, 440.f, 587.3f, 698.5f, 880.f, 1174.7f, 1396.9f, 1760.f};
static Biquad pad_f[2][NPAD], rumble_f[2], roar_f[2][2], wash_f[2][2], ship_f[2];
static Drift pad_d[NPAD], roar_d, wash_d, rumble_d;
static float brown[2], ship_s;
static double ship_ph;

// Things happening in the city, far off: horns, metal struck, signal pips.
typedef struct { int kind; float age, f1, f2, amp, pan; } Event;
static Event ev[4];
static int ev_wait = SR * 6;

static float event_sample(Event *e) {
    float t = e->age, s = 0;
    e->age += 1.f / SR;
    switch (e->kind) {
    case 1: { // horn: two slow notes a little apart
        float env = fminf(t / .7f, 1.f) * fminf(fmaxf((4.f - t) / 1.8f, 0.f), 1.f);
        s = (sinf(TAU * e->f1 * t) + sinf(TAU * e->f2 * t) + .3f * sinf(TAU * 2 * e->f1 * t)) * env * .5f;
        if (t > 4.f) e->kind = 0;
        break;
    }
    case 2: // struck metal: inharmonic partials dying quickly
        s = sinf(TAU * e->f1 * t) * expf(-5 * t) + .6f * sinf(TAU * e->f1 * 2.76f * t) * expf(-7 * t) +
            .35f * sinf(TAU * e->f1 * 5.4f * t) * expf(-9 * t);
        if (t > 1.5f) e->kind = 0;
        break;
    case 3: { // three signal pips
        float u = fmodf(t, .38f);
        s = sinf(TAU * e->f1 * t) * expf(-9 * u) * (u < .003f ? u / .003f : 1.f);
        if (t > 1.14f) e->kind = 0;
        break;
    }
    }
    return s * e->amp;
}

static int inited;
static void init(void) {
    inited = 1;
    for (int c = 0; c < 2; c++) {
        for (int k = 0; k < NPAD; k++) bq_set(&pad_f[c][k], 1, pad_hz[k] * (c ? 1.003f : .997f), 70);
        bq_set(&rumble_f[c], 0, 85, .7f);
        bq_set(&roar_f[c][0], 0, 420, .6f);
        bq_set(&roar_f[c][1], 1, 190, .5f);
        bq_set(&wash_f[c][0], 1, 800, .6f);
        bq_set(&wash_f[c][1], 0, 1500, .7f);
        bq_set(&ship_f[c], 0, 170, .8f);
    }
    for (int k = 0; k < NPAD; k++) pad_d[k] = (Drift){0, 0, SR * k / 2, 0, 1, 9 + 3 * k};
    roar_d = (Drift){.5f, .5f, 0, .25f, 1, 11};
    wash_d = (Drift){.5f, .5f, 0, .2f, 1, 7};
    rumble_d = (Drift){.7f, .7f, 0, .5f, 1, 13};
}

// Fills interleaved stereo float samples.
void audio_fill(float *out, int frames) {
    if (!inited) init();
    for (int i = 0; i < frames; i++) {
        lfo_t += 1. / SR;
        float dry[2] = {0, 0}, wet[2] = {0, 0};

        // drone: low sines breathing against each other
        for (int k = 0; k < NDRONE; k++) {
            drone_ph[k] += drone_hz[k] * (1 + .0015 * sin(lfo_t * (.11 + .03 * k))) / SR;
            if (drone_ph[k] > 1) drone_ph[k] -= 1;
            float s = sin(TAU * drone_ph[k]) * drone_amp[k] * (.55 + .45 * sin(lfo_t * TAU / (17 + 6.3 * k) + k));
            dry[0] += s * (.5 + .12 * sin(lfo_t * .07 + k));
            dry[1] += s * (.5 - .12 * sin(lfo_t * .07 + k));
        }
        float pads[NPAD], ra = drift(&roar_d), wa = drift(&wash_d), ru = drift(&rumble_d);
        for (int k = 0; k < NPAD; k++) pads[k] = drift(&pad_d[k]);
        ship_s += (audio_ship - ship_s) * (1.f / (SR * 1.5f));
        ship_ph += 1. / SR;

        for (int c = 0; c < 2; c++) {
            float white = rnd();
            brown[c] = (brown[c] + .02f * white) / 1.02f;
            dry[c] += bq(&rumble_f[c], brown[c]) * 9.f * ru;                          // sub rumble
            dry[c] += bq(&roar_f[c][1], bq(&roar_f[c][0], white)) * .045f * ra;        // air roar, 100-400 Hz
            float pad = 0;                                                            // wind tones
            for (int k = 0; k < NPAD; k++) {
                float pan = c ? .35f + .3f * (k & 1) : .65f - .3f * (k & 1);
                pad += bq(&pad_f[c][k], white) * pads[k] * pads[k] * pan * (500.f / (pad_hz[k] + 200.f));
            }
            dry[c] += pad * 4.f;
            wet[c] += pad * 6.f;
            wet[c] += bq(&wash_f[c][1], bq(&wash_f[c][0], rnd())) * .05f * wa;       // distant traffic wash
            // a ship passing: a slow throb with a rough roar under it
            float throb = sin(TAU * 31. * ship_ph) * (.7 + .3 * sin(TAU * 2.3 * ship_ph)) + .5 * sin(TAU * 46.5 * ship_ph);
            dry[c] += (throb * .28f + bq(&ship_f[c], rnd()) * .35f) * ship_s * ship_s;
        }

        if (--ev_wait <= 0) {
            ev_wait = (int)(SR * (3 + 9 * rnd01()));
            for (int k = 0; k < 4; k++)
                if (!ev[k].kind) {
                    float r = rnd01();
                    ev[k].kind = r < .4f ? 1 : r < .75f ? 2 : 3;
                    ev[k].age = 0;
                    ev[k].pan = rnd01();
                    ev[k].f1 = ev[k].kind == 1 ? 130 + 140 * rnd01() : ev[k].kind == 2 ? 180 + 260 * rnd01() : 900 + 700 * rnd01();
                    ev[k].f2 = ev[k].f1 * (rnd01() < .5f ? 1.189f : 1.335f);
                    ev[k].amp = (ev[k].kind == 3 ? .02f : .05f) * (.4f + .6f * rnd01());
                    break;
                }
        }
        for (int k = 0; k < 4; k++)
            if (ev[k].kind) {
                float s = event_sample(&ev[k]);
                wet[0] += s * (1 - ev[k].pan);
                wet[1] += s * ev[k].pan;
                dry[0] += s * .1f * (1 - ev[k].pan);
                dry[1] += s * .1f * ev[k].pan;
            }

        float r0 = reverb(0, wet[0] + .1f * dry[0]), r1 = reverb(1, wet[1] + .1f * dry[1]);
        float fade = fminf((float)lfo_t / 5.f, 1.f);
        out[i * 2] = tanhf((dry[0] + r0 * .8f + r1 * .2f) * .8f) * fade;
        out[i * 2 + 1] = tanhf((dry[1] + r1 * .8f + r0 * .2f) * .8f) * fade;
    }
}

static pthread_t thread;
static float volume;

static void *run(void *arg) {
    snd_pcm_t *pcm = arg;
    float f[1024 * 2];
    int16_t s[1024 * 2];
    for (;;) {
        audio_fill(f, 1024);
        for (int i = 0; i < 2048; i++) s[i] = (int16_t)(f[i] * volume * 32000.f);
        snd_pcm_sframes_t n = snd_pcm_writei(pcm, s, 1024);
        if (n < 0 && snd_pcm_recover(pcm, n, 1) < 0) break;
    }
    return NULL;
}

int audio_start(double vol) {
    snd_pcm_t *pcm;
    if (snd_pcm_open(&pcm, "default", SND_PCM_STREAM_PLAYBACK, 0) < 0 ||
        snd_pcm_set_params(pcm, SND_PCM_FORMAT_S16_LE, SND_PCM_ACCESS_RW_INTERLEAVED, 2, SR, 1, 120000) < 0) {
        fprintf(stderr, "habitat: no audio device, continuing silent\n");
        return -1;
    }
    volume = vol;
    return pthread_create(&thread, NULL, run, pcm);
}

// Renders the soundscape to a 16-bit stereo WAV file instead of playing it.
int audio_wav(const char *path, double seconds, double vol, double (*ship)(double t)) {
    FILE *f = fopen(path, "wb");
    if (!f) return -1;
    uint32_t n = (uint32_t)(seconds * SR), bytes = n * 4;
    uint32_t hdr[11] = {0x46464952, 36 + bytes, 0x45564157, 0x20746d66, 16, 0x00020001, SR, SR * 4, 0x00100004, 0x61746164, bytes};
    fwrite(hdr, 4, 11, f);
    float b[2];
    for (uint32_t i = 0; i < n; i++) {
        if (!(i & 255)) audio_ship = ship(i / (double)SR);
        audio_fill(b, 1);
        int16_t s[2] = {(int16_t)(b[0] * vol * 32000.f), (int16_t)(b[1] * vol * 32000.f)};
        fwrite(s, 2, 2, f);
    }
    return fclose(f);
}
