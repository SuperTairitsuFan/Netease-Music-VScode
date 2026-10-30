#include "naoe.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  NaoeFormat format;
  double volume;
  uint64_t played;
  int paused;
  int written_frames;
} NullHandle;

static int null_open(const NaoeConfig *cfg, NaoeFormat *actual, int *buffer_frames, void **out, char *err,
                     size_t err_len, char *supported, size_t supported_len) {
  (void)err;
  (void)err_len;
  (void)supported;
  (void)supported_len;
  NullHandle *handle = (NullHandle *)calloc(1, sizeof(NullHandle));
  if (!handle) return -1;
  handle->format.sample_rate = cfg->sample_rate;
  handle->format.channels = cfg->channels;
  handle->format.bits = cfg->bits;
  snprintf(handle->format.sample_format, sizeof(handle->format.sample_format), "%s", cfg->sample_format);
  handle->volume = cfg->volume <= 0 ? 1.0 : cfg->volume;
  *actual = handle->format;
  *buffer_frames = cfg->buffer_ms > 0 ? (cfg->sample_rate * cfg->buffer_ms) / 1000 : 512;
  if (*buffer_frames < 64) *buffer_frames = 64;
  *out = handle;
  return 0;
}

static int null_write(void *opaque, const float *interleaved, int frames) {
  NullHandle *handle = (NullHandle *)opaque;
  if (!handle || frames <= 0) return 0;
  (void)interleaved;
  handle->played += (uint64_t)frames;
  handle->written_frames += frames;
  int ms = (int)((int64_t)frames * 1000 / (handle->format.sample_rate > 0 ? handle->format.sample_rate : 48000));
  naoe_sleep_ms(ms > 0 ? ms : 1);
  return frames;
}

static int null_position(void *opaque, uint64_t *played) {
  NullHandle *handle = (NullHandle *)opaque;
  if (!handle) return -1;
  *played = handle->played;
  return 0;
}

static void null_pause(void *opaque, int paused) {
  NullHandle *handle = (NullHandle *)opaque;
  if (handle) handle->paused = paused;
}

static void null_volume(void *opaque, double gain) {
  NullHandle *handle = (NullHandle *)opaque;
  if (handle) handle->volume = gain;
}

static void null_flush(void *opaque) {
  (void)opaque;
}

static int null_drain(void *opaque) {
  (void)opaque;
  return 0;
}

static void null_close(void *opaque) { free(opaque); }

static int null_probe(const NaoeBackend *backend, char *json, size_t json_len) {
  (void)backend;
  static const int rates[] = {44100, 48000, 96000, 192000};
  static const int bits[] = {16, 24, 32};
  size_t used = 0;
  used += (size_t)snprintf(json + used, json_len - used,
                           "[{\"id\":\"null\",\"name\":\"Null output (test)\",\"backend\":\"null\","
                           "\"isDefault\":true,\"formats\":[");
  int first = 1;
  for (size_t r = 0; r < sizeof(rates) / sizeof(rates[0]); r++) {
    for (size_t b = 0; b < sizeof(bits) / sizeof(bits[0]); b++) {
      if (!first) used += (size_t)snprintf(json + used, json_len - used, ",");
      first = 0;
      const char *sf = bits[b] == 16 ? "s16le" : bits[b] == 24 ? "s24le" : "s32le";
      used += (size_t)snprintf(json + used, json_len - used,
                               "{\"sampleRate\":%d,\"bits\":%d,\"channels\":2,\"sampleFormat\":\"%s\"}",
                               rates[r], bits[b], sf);
    }
  }
  used += (size_t)snprintf(json + used, json_len - used, "]}]");
  return 1;
}

const NaoeBackend naoe_null_backend = {
    .name = "null",
    .open = null_open,
    .write = null_write,
    .position = null_position,
    .pause = null_pause,
    .volume = null_volume,
    .flush = null_flush,
    .drain = null_drain,
    .close = null_close,
    .probe = null_probe,
};
