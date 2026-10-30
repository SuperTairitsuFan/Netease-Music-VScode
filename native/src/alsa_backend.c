/*
 * ALSA / PipeWire backend.
 *
 * libasound is loaded with dlopen() on purpose: the engine binary then has no
 * hard link-time dependency on ALSA, so a missing PipeWire/ALSA installation
 * produces a clear runtime error instead of a loader failure.
 *
 * Opening a `hw:` device talks to the hardware directly; `default` goes
 * through PipeWire/PulseAudio when those are configured as the ALSA default.
 */
#include "naoe.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(__linux__)

#include <alsa/asoundlib.h>
#include <dlfcn.h>
#include <errno.h>

typedef struct {
  void *lib;
  snd_pcm_t *pcm;
  snd_pcm_format_t format;
  int sample_rate;
  int channels;
  int bits;
  int buffer_frames;
  volatile double volume;
  uint64_t written;
  unsigned char *convert;
  size_t convert_capacity;
} AlsaHandle;

static void *g_lib;
static int g_loaded;
static char g_load_error[256];

#define ALSA_SYMS(X)                                                                                              \
  X(snd_pcm_open)                                                                                                 \
  X(snd_pcm_close)                                                                                                \
  X(snd_pcm_hw_params_malloc)                                                                                     \
  X(snd_pcm_hw_params_free)                                                                                       \
  X(snd_pcm_hw_params_any)                                                                                        \
  X(snd_pcm_hw_params_set_access)                                                                                 \
  X(snd_pcm_hw_params_set_format)                                                                                 \
  X(snd_pcm_hw_params_set_channels)                                                                               \
  X(snd_pcm_hw_params_test_format)                                                                                \
  X(snd_pcm_hw_params_test_channels)                                                                              \
  X(snd_pcm_hw_params_test_rate)                                                                                  \
  X(snd_pcm_hw_params_set_rate_near)                                                                              \
  X(snd_pcm_hw_params_set_period_time_near)                                                                       \
  X(snd_pcm_hw_params_set_buffer_time_near)                                                                       \
  X(snd_pcm_hw_params)                                                                                            \
  X(snd_pcm_hw_params_get_buffer_size)                                                                            \
  X(snd_pcm_prepare)                                                                                              \
  X(snd_pcm_writei)                                                                                               \
  X(snd_pcm_drain)                                                                                                \
  X(snd_pcm_drop)                                                                                                 \
  X(snd_pcm_pause)                                                                                                \
  X(snd_pcm_delay)                                                                                                \
  X(snd_pcm_recover)                                                                                              \
  X(snd_strerror)                                                                                                 \
  X(snd_device_name_hint)                                                                                         \
  X(snd_device_name_get_hint)                                                                                     \
  X(snd_device_name_free_hint)

#define DECLARE_PTR(name) static __typeof__(&name) p_##name;
ALSA_SYMS(DECLARE_PTR)
#undef DECLARE_PTR

static int load_alsa(void) {
  if (g_loaded) return g_lib ? 0 : -1;
  g_loaded = 1;
  const char *candidates[] = {"libasound.so.2", "libasound.so", NULL};
  for (int i = 0; candidates[i]; i++) {
    g_lib = dlopen(candidates[i], RTLD_NOW | RTLD_LOCAL);
    if (g_lib) break;
  }
  if (!g_lib) {
    snprintf(g_load_error, sizeof(g_load_error), "无法加载 libasound.so.2：%s", dlerror());
    return -1;
  }
#define LOAD_PTR(name)                                                                                            \
  p_##name = (__typeof__(&name))dlsym(g_lib, #name);                                                                  \
  if (!p_##name) {                                                                                                \
    snprintf(g_load_error, sizeof(g_load_error), "libasound 缺少符号：%s", #name);                                 \
    return -1;                                                                                                    \
  }
  ALSA_SYMS(LOAD_PTR)
#undef LOAD_PTR
  return 0;
}

static snd_pcm_format_t format_for(int bits, const char *sample_format) {
  if (sample_format && strcmp(sample_format, "f32le") == 0) return SND_PCM_FORMAT_FLOAT_LE;
  if (sample_format && strcmp(sample_format, "s24le") == 0) return SND_PCM_FORMAT_S24_3LE;
  if (sample_format && strcmp(sample_format, "s32le") == 0) return SND_PCM_FORMAT_S32_LE;
  if (sample_format && strcmp(sample_format, "s16le") == 0) return SND_PCM_FORMAT_S16_LE;
  if (bits == 16) return SND_PCM_FORMAT_S16_LE;
  if (bits == 24) return SND_PCM_FORMAT_S24_3LE;
  return SND_PCM_FORMAT_S32_LE;
}

static const char *format_name(int bits, snd_pcm_format_t format) {
  if (format == SND_PCM_FORMAT_FLOAT_LE) return "f32le";
  if (format == SND_PCM_FORMAT_S24_3LE) return "s24le";
  if (format == SND_PCM_FORMAT_S32_LE) return "s32le";
  (void)bits;
  return "s16le";
}

/* Tests which PCM formats a device really accepts. */
static int device_formats(const char *name, char *out, size_t out_len, int *count_out) {
  static const int rates[] = {44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000};
  static const int bits_list[] = {16, 24, 32};
  snd_pcm_t *pcm = NULL;
  if (p_snd_pcm_open(&pcm, name, SND_PCM_STREAM_PLAYBACK, SND_PCM_NONBLOCK) != 0) {
    if (count_out) *count_out = 0;
    if (out_len) out[0] = '\0';
    return -1;
  }
  snd_pcm_hw_params_t *params = NULL;
  p_snd_pcm_hw_params_malloc(&params);
  p_snd_pcm_hw_params_any(pcm, params);
  size_t used = 0;
  int count = 0;
  for (size_t r = 0; r < sizeof(rates) / sizeof(rates[0]); r++) {
    for (size_t b = 0; b < sizeof(bits_list) / sizeof(bits_list[0]); b++) {
      snd_pcm_format_t format = format_for(bits_list[b], NULL);
      if (p_snd_pcm_hw_params_test_format(pcm, params, format) != 0) continue;
      if (p_snd_pcm_hw_params_test_channels(pcm, params, 2) != 0) continue;
      if (p_snd_pcm_hw_params_test_rate(pcm, params, (unsigned int)rates[r], 0) != 0) continue;
      if (count > 0 && used + 128 < out_len) used += (size_t)snprintf(out + used, out_len - used, ",");
      used += (size_t)snprintf(out + used, out_len - used,
                               "{\"sampleRate\":%d,\"bits\":%d,\"channels\":2,\"sampleFormat\":\"%s\"}",
                               rates[r], bits_list[b], format_name(bits_list[b], format));
      count++;
    }
  }
  p_snd_pcm_hw_params_free(params);
  p_snd_pcm_close(pcm);
  if (count_out) *count_out = count;
  return 0;
}

static int alsa_probe(const NaoeBackend *backend, char *json, size_t json_len) {
  (void)backend;
  if (load_alsa() != 0) {
    snprintf(json, json_len, "[]");
    return 0;
  }
  void **hints = NULL;
  if (p_snd_device_name_hint(-1, "pcm", &hints) != 0) {
    snprintf(json, json_len, "[]");
    return 0;
  }
  size_t used = 0;
  int emitted = 0;
  int seen_default = 0;
  used += (size_t)snprintf(json + used, json_len - used, "[");
  for (void **hint = hints; *hint && emitted < 12; hint++) {
    char *name = p_snd_device_name_get_hint(*hint, "NAME");
    char *desc = p_snd_device_name_get_hint(*hint, "DESC");
    char *ioid = p_snd_device_name_get_hint(*hint, "IOID");
    if (!name) {
      free(desc);
      free(ioid);
      continue;
    }
    if (ioid && strcmp(ioid, "Output") != 0) {
      free(name);
      free(desc);
      free(ioid);
      continue;
    }
    char formats[4096];
    int format_count = 0;
    device_formats(name, formats, sizeof(formats), &format_count);
    if (format_count == 0) {
      free(name);
      free(desc);
      free(ioid);
      continue;
    }
    char esc_name[512];
    char esc_desc[512];
    naoe_json_escape(name, esc_name, sizeof(esc_name));
    naoe_json_escape(desc ? desc : name, esc_desc, sizeof(esc_desc));
    if (emitted > 0) used += (size_t)snprintf(json + used, json_len - used, ",");
    int is_default = strcmp(name, "default") == 0;
    if (is_default) seen_default = 1;
    used += (size_t)snprintf(json + used, json_len - used,
                             "{\"id\":\"%s\",\"name\":\"%s\",\"backend\":\"alsa\",\"isDefault\":%s,"
                             "\"formats\":[%s]}",
                             esc_name, esc_desc, is_default ? "true" : "false", formats);
    emitted++;
    free(name);
    free(desc);
    free(ioid);
    if (used + 1024 > json_len) break;
  }
  p_snd_device_name_free_hint(hints);
  if (!seen_default && emitted < 12) {
    char formats[4096];
    int format_count = 0;
    device_formats("default", formats, sizeof(formats), &format_count);
    if (format_count > 0) {
      if (emitted > 0) used += (size_t)snprintf(json + used, json_len - used, ",");
      used += (size_t)snprintf(json + used, json_len - used,
                               "{\"id\":\"default\",\"name\":\"系统默认设备\",\"backend\":\"alsa\","
                               "\"isDefault\":true,\"formats\":[%s]}",
                               formats);
      emitted++;
    }
  }
  used += (size_t)snprintf(json + used, json_len - used, "]");
  return emitted;
}

static int alsa_open(const NaoeConfig *cfg, NaoeFormat *actual, int *buffer_frames, void **out, char *err,
                     size_t err_len, char *supported, size_t supported_len) {
  if (load_alsa() != 0) {
    snprintf(err, err_len, "%s", g_load_error);
    snprintf(supported, supported_len, "[]");
    return -1;
  }
  const char *device = cfg->device[0] && strcmp(cfg->device, "default") != 0 ? cfg->device : "default";
  AlsaHandle *handle = (AlsaHandle *)calloc(1, sizeof(AlsaHandle));
  if (!handle) {
    snprintf(err, err_len, "内存不足");
    return -1;
  }
  int rc = p_snd_pcm_open(&handle->pcm, device, SND_PCM_STREAM_PLAYBACK, 0);
  if (rc != 0) {
    snprintf(err, err_len, "打开 ALSA 设备 %s 失败：%s（独占/直连请使用 hw: 设备）", device,
             p_snd_strerror(rc));
    device_formats(device, supported, supported_len, NULL);
    free(handle);
    return -1;
  }

  snd_pcm_hw_params_t *params = NULL;
  p_snd_pcm_hw_params_malloc(&params);
  p_snd_pcm_hw_params_any(handle->pcm, params);
  handle->format = format_for(cfg->bits, cfg->sample_format);
  handle->channels = cfg->channels;
  handle->sample_rate = cfg->sample_rate;

  int failed = 0;
  char detail[256] = {0};
  if (p_snd_pcm_hw_params_set_access(handle->pcm, params, SND_PCM_ACCESS_RW_INTERLEAVED) != 0) {
    snprintf(detail, sizeof(detail), "不支持交错访问");
    failed = 1;
  } else if (p_snd_pcm_hw_params_set_format(handle->pcm, params, handle->format) != 0) {
    snprintf(detail, sizeof(detail), "设备不支持格式 %s", format_name(cfg->bits, handle->format));
    failed = 1;
  } else if (p_snd_pcm_hw_params_set_channels(handle->pcm, params, (unsigned int)cfg->channels) != 0) {
    snprintf(detail, sizeof(detail), "设备不支持 %d 声道", cfg->channels);
    failed = 1;
  } else if (p_snd_pcm_hw_params_set_rate_near(handle->pcm, params, (unsigned int *)&handle->sample_rate, NULL) != 0) {
    snprintf(detail, sizeof(detail), "设备不支持采样率协商");
    failed = 1;
  } else if (handle->sample_rate != cfg->sample_rate) {
    snprintf(detail, sizeof(detail), "设备不支持 %d Hz，最接近 %d Hz（不做重采样）", cfg->sample_rate,
             handle->sample_rate);
    failed = 1;
  }

  if (failed) {
    snprintf(err, err_len, "格式协商失败：%s", detail);
    device_formats(device, supported, supported_len, NULL);
    p_snd_pcm_hw_params_free(params);
    p_snd_pcm_close(handle->pcm);
    free(handle);
    return -1;
  }

  unsigned int buffer_us = (unsigned int)(cfg->buffer_ms > 0 ? cfg->buffer_ms : 10) * 1000u;
  unsigned int period_us = buffer_us / 4;
  if (period_us < 1000) period_us = 1000;
  p_snd_pcm_hw_params_set_period_time_near(handle->pcm, params, &period_us, NULL);
  if (p_snd_pcm_hw_params_set_buffer_time_near(handle->pcm, params, &buffer_us, NULL) != 0) {
    buffer_us = 50000;
  }
  rc = p_snd_pcm_hw_params(handle->pcm, params);
  if (rc != 0) {
    snprintf(err, err_len, "应用 ALSA 参数失败：%s", p_snd_strerror(rc));
    device_formats(device, supported, supported_len, NULL);
    p_snd_pcm_hw_params_free(params);
    p_snd_pcm_close(handle->pcm);
    free(handle);
    return -1;
  }
  snd_pcm_uframes_t frames = 0;
  p_snd_pcm_hw_params_get_buffer_size(params, &frames);
  p_snd_pcm_hw_params_free(params);
  handle->buffer_frames = (int)frames;
  p_snd_pcm_prepare(handle->pcm);
  handle->volume = cfg->volume <= 0 ? 1.0 : cfg->volume;
  handle->convert_capacity = (size_t)handle->buffer_frames * (size_t)handle->channels * 4u + 4096u;
  handle->convert = (unsigned char *)malloc(handle->convert_capacity);
  if (!handle->convert) {
    snprintf(err, err_len, "内存不足");
    p_snd_pcm_close(handle->pcm);
    free(handle);
    return -1;
  }

  actual->sample_rate = handle->sample_rate;
  actual->channels = handle->channels;
  actual->bits = handle->format == SND_PCM_FORMAT_S16_LE ? 16 : handle->format == SND_PCM_FORMAT_S24_3LE ? 24 : 32;
  snprintf(actual->sample_format, sizeof(actual->sample_format), "%s", format_name(cfg->bits, handle->format));
  *buffer_frames = handle->buffer_frames;
  *out = handle;
  return 0;
}

static int alsa_write(void *opaque, const float *input, int frames) {
  AlsaHandle *handle = (AlsaHandle *)opaque;
  if (!handle || frames <= 0) return 0;
  int channels = handle->channels;
  size_t samples = (size_t)frames * (size_t)channels;
  double gain = handle->volume;
  unsigned char *out = handle->convert;
  if (handle->format == SND_PCM_FORMAT_FLOAT_LE) {
    float *dst = (float *)out;
    for (size_t i = 0; i < samples; i++) dst[i] = (float)(input[i] * gain);
    frames = (int)frames;
  } else if (handle->format == SND_PCM_FORMAT_S16_LE) {
    int16_t *dst = (int16_t *)out;
    for (size_t i = 0; i < samples; i++) {
      double v = input[i] * gain;
      if (v > 1.0) v = 1.0;
      if (v < -1.0) v = -1.0;
      dst[i] = (int16_t)(v * 32767.0);
    }
  } else if (handle->format == SND_PCM_FORMAT_S24_3LE) {
    for (size_t i = 0; i < samples; i++) {
      double v = input[i] * gain;
      if (v > 1.0) v = 1.0;
      if (v < -1.0) v = -1.0;
      int32_t sample = (int32_t)(v * 8388607.0);
      out[i * 3 + 0] = (unsigned char)(sample & 0xff);
      out[i * 3 + 1] = (unsigned char)((sample >> 8) & 0xff);
      out[i * 3 + 2] = (unsigned char)((sample >> 16) & 0xff);
    }
  } else {
    int32_t *dst = (int32_t *)out;
    for (size_t i = 0; i < samples; i++) {
      double v = input[i] * gain;
      if (v > 1.0) v = 1.0;
      if (v < -1.0) v = -1.0;
      dst[i] = (int32_t)(v * 2147483647.0);
    }
  }

  int written = 0;
  while (written < frames) {
    snd_pcm_sframes_t rc =
        p_snd_pcm_writei(handle->pcm, out + (size_t)written * (size_t)channels * (size_t)(handle->format == SND_PCM_FORMAT_S24_3LE ? 3 : (handle->format == SND_PCM_FORMAT_S16_LE ? 2 : 4)),
                         (snd_pcm_uframes_t)(frames - written));
    if (rc == -EPIPE) {
      p_snd_pcm_prepare(handle->pcm);
      return -1;
    }
    if (rc == -ESTRPIPE) {
      while (p_snd_pcm_recover(handle->pcm, (int)rc, 1) == -EAGAIN) naoe_sleep_ms(10);
      p_snd_pcm_prepare(handle->pcm);
      return -1;
    }
    if (rc == -ENODEV) return -2;
    if (rc < 0) return -1;
    written += (int)rc;
    handle->written += (uint64_t)rc;
  }
  return frames;
}

static int alsa_position(void *opaque, uint64_t *played) {
  AlsaHandle *handle = (AlsaHandle *)opaque;
  if (!handle) return -1;
  snd_pcm_sframes_t delay = 0;
  if (p_snd_pcm_delay(handle->pcm, &delay) == 0 && delay >= 0) {
    *played = handle->written > (uint64_t)delay ? handle->written - (uint64_t)delay : 0;
  } else {
    *played = handle->written;
  }
  return 0;
}

static void alsa_pause(void *opaque, int paused) {
  AlsaHandle *handle = (AlsaHandle *)opaque;
  if (handle && handle->pcm) p_snd_pcm_pause(handle->pcm, paused);
}

static void alsa_volume(void *opaque, double gain) {
  AlsaHandle *handle = (AlsaHandle *)opaque;
  if (handle) handle->volume = gain;
}

static void alsa_flush(void *opaque) {
  AlsaHandle *handle = (AlsaHandle *)opaque;
  if (!handle || !handle->pcm) return;
  p_snd_pcm_drop(handle->pcm);
  p_snd_pcm_prepare(handle->pcm);
  handle->written = 0;
}

static int alsa_drain(void *opaque) {
  AlsaHandle *handle = (AlsaHandle *)opaque;
  if (!handle || !handle->pcm) return 0;
  p_snd_pcm_drain(handle->pcm);
  return 0;
}

static void alsa_close(void *opaque) {
  AlsaHandle *handle = (AlsaHandle *)opaque;
  if (!handle) return;
  if (handle->pcm) p_snd_pcm_close(handle->pcm);
  free(handle->convert);
  free(handle);
}

const NaoeBackend naoe_alsa_backend = {
    .name = "alsa",
    .open = alsa_open,
    .write = alsa_write,
    .position = alsa_position,
    .pause = alsa_pause,
    .volume = alsa_volume,
    .flush = alsa_flush,
    .drain = alsa_drain,
    .close = alsa_close,
    .probe = alsa_probe,
};

#else /* !__linux__ */

static int alsa_open(const NaoeConfig *cfg, NaoeFormat *actual, int *buffer_frames, void **out, char *err,
                     size_t err_len, char *supported, size_t supported_len) {
  (void)cfg;
  (void)actual;
  (void)buffer_frames;
  (void)out;
  (void)supported;
  (void)supported_len;
  snprintf(err, err_len, "此二进制不包含 ALSA 后端");
  return -1;
}

const NaoeBackend naoe_alsa_backend = {
    .name = "alsa",
    .open = alsa_open,
    .write = NULL,
    .position = NULL,
    .pause = NULL,
    .volume = NULL,
    .flush = NULL,
    .drain = NULL,
    .close = NULL,
    .probe = NULL,
};

#endif
