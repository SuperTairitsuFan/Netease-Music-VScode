/*
 * Native Audio Output Engine (NAOE) - shared definitions.
 *
 * The engine is deliberately small: it receives decoded float32 interleaved
 * PCM on stdin and hands it to a platform backend (WASAPI / ALSA). It never
 * decodes, never fetches audio and never renders UI.
 */
#ifndef NAOE_H
#define NAOE_H

#include <stddef.h>
#include <stdint.h>

#define NAOE_VERSION "0.1.0"
#define NAOE_PROTOCOL "1"

#define NAOE_FRAME_CONTROL 1u
#define NAOE_FRAME_PCM 2u
#define NAOE_FRAME_END 3u

typedef struct {
  char device[512];
  int sample_rate;
  int channels;
  int bits;
  char sample_format[8];
  int exclusive;
  int buffer_ms;
  double volume;
} NaoeConfig;

typedef struct {
  int sample_rate;
  int channels;
  int bits;
  char sample_format[8];
} NaoeFormat;

typedef struct NaoeBackend NaoeBackend;

struct NaoeBackend {
  const char *name;
  /* Opens the device. PCM passed to write() is always float32 interleaved. */
  int (*open)(const NaoeConfig *cfg, NaoeFormat *actual, int *buffer_frames, void **handle, char *err,
              size_t err_len, char *supported, size_t supported_len);
  /* Blocking write of `frames` float32 frames. Returns frames written or < 0. */
  int (*write)(void *handle, const float *interleaved, int frames);
  /* Frames actually played by the device (for progress reporting). */
  int (*position)(void *handle, uint64_t *played_frames);
  void (*pause)(void *handle, int paused);
  void (*volume)(void *handle, double gain);
  void (*flush)(void *handle);
  /* Blocks until buffered audio has been consumed. */
  int (*drain)(void *handle);
  void (*close)(void *handle);
  /* Fills `json` with an array of device objects. Returns device count. */
  int (*probe)(const NaoeBackend *backend, char *json, size_t json_len);
};

/* Selects a backend by name ("alsa", "wasapi", "null") or NULL for the
 * platform default. Returns 0 on success. */
int naoe_backend_select(const char *name, const NaoeBackend **out);

void naoe_json_escape(const char *input, char *output, size_t output_len);
uint64_t naoe_now_ms(void);
void naoe_sleep_ms(int ms);

#endif
