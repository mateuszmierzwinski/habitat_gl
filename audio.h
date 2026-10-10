#pragma once

extern volatile float audio_ship; // 0..1, how close a ship is to the camera

int audio_start(double volume);
// ship(t) gives the ship proximity at time t, so an offline render sounds like the live one
int audio_wav(const char *path, double seconds, double volume, double (*ship)(double t));
void audio_fill(float *out, int frames);
