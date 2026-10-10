CC      ?= gcc
CFLAGS  ?= -O2 -Wall -Wextra
LDLIBS   = -lGL -lX11 -lasound -lpthread -lm
SHADERS  = scene.frag taa.frag bloom.frag post.frag

habitat: main.c audio.c audio.h facts.h $(SHADERS)
	$(CC) -std=gnu23 $(CFLAGS) -o $@ main.c audio.c $(LDLIBS)

clean:
	rm -f habitat

.PHONY: clean
