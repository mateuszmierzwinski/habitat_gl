# Habitat

A procedurally generated screensaver for Linux, written in C and OpenGL. The camera flies through an
endless tube-shaped space station: a dense city wrapped around the inside of a spinning cylinder, fog
banks drifting past, large ships and their drones passing down the axis with searchlights, and colours
that slowly cycle through blue, purple, red, green and yellow.

There are no 3D models, textures, fonts or sound files. Every shape is a distance function raymarched
in a fragment shader, the soundscape is synthesised, and the whole thing compiles to a single binary of
about 130 KB. It can also render itself to video, including side-by-side 3D and VR180 for a headset.

## Requirements

- Linux with X11 and a GPU that supports OpenGL 3.3 core (developed on an NVIDIA RTX 3060)
- A C23 compiler with `#embed` support: GCC 15 or Clang 19, or newer
- Development headers for OpenGL, Xlib and ALSA
- `ffmpeg` with libx264, only for `-record`

```sh
# Fedora
sudo dnf install gcc make mesa-libGL-devel libX11-devel alsa-lib-devel ffmpeg

# Debian / Ubuntu
sudo apt install gcc make libgl-dev libx11-dev libasound2-dev ffmpeg
```

## Build

```sh
make
```

The shaders are embedded into the binary at compile time, so `habitat` runs from anywhere on its own.

## Run

```sh
./habitat              # fullscreen film; any key, click or mouse move quits
./habitat -hold        # fullscreen, only Esc or q quits
./habitat -window      # 1280x720 window
./habitat -plain       # just the endless flight: no opening, captions or camera changes
```

By default it plays as a film: an opening card and title, three cameras taking 30-second turns (beside
the station axis, on a ship's bow antenna, on a drone circling that ship), and a caption about the
project once a minute. The caption text lives in `facts.h`.

To use it with XScreenSaver, point a program entry at `habitat -root`; it also honours
`$XSCREENSAVER_WINDOW` and `-window-id`.

## Recording

```sh
./habitat -record habitat.mp4 600                 # 10 minutes, 1920x1080, 30 fps
./habitat -stereo -record habitat_3d.mp4 600      # side-by-side 3D, 3840x2160, 30 fps
./habitat -stereo180 -record habitat_LR_180.mp4 600   # VR180, 4320x2160, 60 fps
```

Frames are read back from the GPU and piped raw into `ffmpeg`, which encodes H.264 and muxes the
synthesised audio. Recording is offline, so the result is smooth regardless of how fast it renders.
3D recordings are tagged in the file as left-right stereo, and `-stereo180` ones also as VR180
(equirectangular, front half-sphere), for YouTube and headset players.

## Options

| Option | Meaning |
|---|---|
| `-hold` | Ignore the mouse and keyboard; only Esc or q quits |
| `-window` | 1280x720 window; Esc or q quits |
| `-root` | Draw on the root window |
| `-window-id ID` | Draw inside an existing window (also `$XSCREENSAVER_WINDOW`) |
| `-stereo` | Side-by-side 3D: left and right eye, each squeezed into half the frame |
| `-stereo180` | 3D for a headset: each eye a 180-degree longitude-latitude view, side by side |
| `-ipd F` | Eye separation for the 3D modes in scene units, default 1.6 |
| `-mute` | No sound |
| `-volume F` | Sound level, default 0.7 |
| `-scale F` | Maximum internal render scale, default 1.0 |
| `-budget MS` | GPU time per frame to hold by lowering the scale, default 14.5 |
| `-cycle SEC` | Seconds for a full colour cycle, default 360 |
| `-t SEC` | Start time offset |
| `-fps` | Print frame times |
| `-size WxH` | Size for `-window`, `-shot`, `-bench` and `-record` |
| `-shot FILE.ppm` | Render one frame offscreen and exit |
| `-bench N` | Time N offscreen frames and exit |
| `-wav FILE SEC` | Write SEC seconds of the soundscape to a WAV file and exit |
| `-record FILE SEC` | Render SEC seconds, picture and sound, to an MP4 and exit |
| `-rfps N` | Frame rate for `-record`, default 30, or 60 for `-stereo180` |
| `-crf N` | x264 quality for `-record`, lower is better, default 20 |
| `-no-intro` | Skip the opening card, fade and title |
| `-no-facts` | No caption each minute |
| `-no-cams` | Stay on the station camera |
| `-plain` | All three of the above |
| `-intro`, `-facts` | Turn those on for `-shot` and `-bench`, where they are off |

## How it works

The world is a pure function of time: give the program a clock value and it knows where every ship and
building is, which is why any frame can be rendered offline and still match the live run.

Each frame is one fullscreen triangle drawn through four shaders:

1. **`scene.frag`** sphere-traces the station, city, ships and drones (up to 260 steps per pixel), then
   shades them and marches the volumetric fog, light beams and glows. Buildings and ships are hashes of
   their grid position, worked out again for every pixel; nothing is stored.
2. **`taa.frag`** blends the jittered frame into a reprojected history for anti-aliasing and upsampling.
3. **`bloom.frag`** builds a six-level bloom pyramid.
4. **`post.frag`** applies exposure, tone curve, grading, vignette and grain, and draws the opening
   card, title and captions from line segments.

Live, the internal resolution scales down when a frame runs over its GPU time budget.

| File | Contents |
|---|---|
| `main.c` | Xlib/GLX host, camera paths, render loop, recording and the MP4 3D tag |
| `audio.c`, `audio.h` | Synthesised soundscape, played through ALSA or written to WAV |
| `facts.h` | The captions shown once a minute |
| `*.frag` | The four shaders above |

## Author

Matt Mierzwinski — [mattmierzwinski.com](https://mattmierzwinski.com)

## License

MIT — see [LICENSE](LICENSE).
