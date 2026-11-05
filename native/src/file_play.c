/* Native streaming file playback: decode FLAC/MP3 as we play. */
#include "naoe.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#if !defined(_WIN32)
#include <strings.h>
#include <pthread.h>
#endif

#if defined(_WIN32)
#include <windows.h>
#endif

#define DR_FLAC_IMPLEMENTATION
#define DR_MP3_IMPLEMENTATION
#define DR_FLAC_NO_OGG
#include "dr_flac.h"
#include "dr_mp3.h"

#if defined(_WIN32)
static SRWLOCK g_emit_lock = SRWLOCK_INIT;
#else
static pthread_mutex_t g_emit_lock = PTHREAD_MUTEX_INITIALIZER;
#endif

static void emit_line(const char *line) {
#if defined(_WIN32)
  AcquireSRWLockExclusive(&g_emit_lock);
#else
  pthread_mutex_lock(&g_emit_lock);
#endif
  fputs(line, stdout);
  fputc('\n', stdout);
  fflush(stdout);
#if defined(_WIN32)
  ReleaseSRWLockExclusive(&g_emit_lock);
#else
  pthread_mutex_unlock(&g_emit_lock);
#endif
}

static int ends_with(const char *s, const char *suffix) {
  size_t n = strlen(s), m = strlen(suffix);
  #if defined(_WIN32)
  return n >= m && _stricmp(s + n - m, suffix) == 0;
#else
  return n >= m && strcasecmp(s + n - m, suffix) == 0;
#endif
}

typedef struct {
  FILE *file;
  const char *done_path;
} GrowFile;

static int done_exists(const char *path) {
#if defined(_WIN32)
  return path && GetFileAttributesA(path) != INVALID_FILE_ATTRIBUTES;
#else
  (void)path;
  return 1;
#endif
}

static size_t grow_read(void *user, void *out, size_t bytes) {
  GrowFile *g = (GrowFile *)user;
  for (;;) {
    size_t got = fread(out, 1, bytes, g->file);
    if (got > 0) return got;
    if (done_exists(g->done_path)) return 0;
    clearerr(g->file);
#if defined(_WIN32)
    Sleep(10);
#else
    naoe_sleep_ms(10);
#endif
  }
}

static drflac_bool32 grow_seek(void *user, int offset, drflac_seek_origin origin) {
  GrowFile *g = (GrowFile *)user;
  int whence = origin == DRFLAC_SEEK_SET ? SEEK_SET : origin == DRFLAC_SEEK_CUR ? SEEK_CUR : SEEK_END;
  return fseek(g->file, offset, whence) == 0 ? DRFLAC_TRUE : DRFLAC_FALSE;
}

static drflac_bool32 grow_tell(void *user, drflac_int64 *cursor) {
  GrowFile *g = (GrowFile *)user;
  long pos = ftell(g->file);
  if (pos < 0) return DRFLAC_FALSE;
  *cursor = (drflac_int64)pos;
  return DRFLAC_TRUE;
}

static volatile int g_pause = 0;
static volatile int g_stop = 0;

typedef struct {
  float *left;
  float *right;
  int size;
  int pos;
} HrtfState;

static void hrtf_reset(HrtfState *h) {
  if (!h) return;
  h->pos = 0;
  if (h->left) memset(h->left, 0, (size_t)h->size * sizeof(float));
  if (h->right) memset(h->right, 0, (size_t)h->size * sizeof(float));
}

static float soft_limit(float x) {
  const float threshold = 0.95f;
  if (x > threshold) return threshold + (1.0f - threshold) * tanhf((x - threshold) / (1.0f - threshold));
  if (x < -threshold) return -threshold + (1.0f - threshold) * tanhf((x + threshold) / (1.0f - threshold));
  return x;
}

static void downmix_to_stereo(const int32_t *src, int frames, int channels, int32_t *dst) {
  for (int i = 0; i < frames; i++) {
    const int32_t *frame = src + (size_t)i * (size_t)channels;
    float l = (float)frame[0] / 2147483647.0f;
    float r = (float)frame[1] / 2147483647.0f;
    if (channels == 4) {
      l += ((float)frame[2] / 2147483647.0f) * 0.707f;
      r += ((float)frame[3] / 2147483647.0f) * 0.707f;
      l *= 0.42f;
      r *= 0.42f;
    } else if (channels >= 5) {
      float c = (float)frame[2] / 2147483647.0f;
      l += c * 0.707f;
      r += c * 0.707f;
      if (channels == 6 || channels >= 7) {
        float lfe = (float)frame[3] / 2147483647.0f;
        l += lfe * 0.25f;
        r += lfe * 0.25f;
      }
      if (channels >= 6) {
        l += ((float)frame[4] / 2147483647.0f) * 0.35f;
        r += ((float)frame[5] / 2147483647.0f) * 0.35f;
      }
      if (channels >= 8) {
        l += ((float)frame[6] / 2147483647.0f) * 0.25f;
        r += ((float)frame[7] / 2147483647.0f) * 0.25f;
      }
    }
    if (channels >= 5) {
      l *= 0.32f;
      r *= 0.32f;
    }
    // channel-sum headroom: 5.1/7.1 can exceed 0 dBFS without this
    if (l > 1.0f) l = 1.0f;
    if (l < -1.0f) l = -1.0f;
    if (r > 1.0f) r = 1.0f;
    if (r < -1.0f) r = -1.0f;
    dst[(size_t)i * 2] = (int32_t)llroundf(l * 2147483647.0f);
    dst[(size_t)i * 2 + 1] = (int32_t)llroundf(r * 2147483647.0f);
  }
}

static void hrtf_process(int32_t *pcm, int frames, int channels, int rate, HrtfState *h) {
  if (!h || !h->left || !h->right || channels != 2) return;
  for (int i = 0; i < frames; i++) {
    float l = (float)pcm[(size_t)i * 2] / 2147483647.0f;
    float r = (float)pcm[(size_t)i * 2 + 1] / 2147483647.0f;
    float mid = (l + r) * 0.5f;
    float side = (l - r) * 0.5f * 1.08f;
    float wide_l = mid + side;
    float wide_r = mid - side;
    float cross_l = h->right[h->pos] * 0.10f;
    float cross_r = h->left[h->pos] * 0.10f;
    float out_l = (wide_l + cross_l) * 0.70f;
    float out_r = (wide_r + cross_r) * 0.70f;
    out_l = soft_limit(out_l);
    out_r = soft_limit(out_r);
    h->left[h->pos] = l;
    h->right[h->pos] = r;
    h->pos = (h->pos + 1) % h->size;
    pcm[(size_t)i * 2] = (int32_t)llroundf(out_l * 2147483647.0f);
    pcm[(size_t)i * 2 + 1] = (int32_t)llroundf(out_r * 2147483647.0f);
  }
  (void)rate;
}
static volatile int g_seek_requested = 0;
static volatile int g_seek_ms = 0;
static volatile float g_volume = 1.0f;

static void *control_thread_main(void *arg) {
  (void)arg;
  unsigned char header[5];
  while (fread(header, 1, 5, stdin) == 5) {
    unsigned int type = header[0];
    unsigned int len = (unsigned int)header[1] | ((unsigned int)header[2] << 8) |
                       ((unsigned int)header[3] << 16) | ((unsigned int)header[4] << 24);
    char *payload = len ? (char *)malloc(len + 1) : NULL;
    if (payload) {
      if (fread(payload, 1, len, stdin) != len) { free(payload); break; }
      payload[len] = '\0';
    }
    if (type == 3) g_stop = 1;
    if (type == 1 && payload) {
      if (strstr(payload, "\"pause\"")) g_pause = 1;
      else if (strstr(payload, "\"resume\"") || strstr(payload, "\"play\"")) g_pause = 0;
      else if (strstr(payload, "\"stop\"")) g_stop = 1;
      else if (strstr(payload, "\"seek\"")) {
        const char *ms = strstr(payload, "\"ms\":");
        if (ms) {
          g_seek_ms = atoi(ms + 5);
          g_seek_requested = 1;
        }
      }
      else if (strstr(payload, "\"volume\"")) {
        const char *value = strstr(payload, "\"value\":");
        if (value) {
          float v = (float)atof(value + 8);
          if (v < 0.0f) v = 0.0f;
          if (v > 1.0f) v = 1.0f;
          g_volume = v;
        }
      }
    }
    free(payload);
    if (g_stop) break;
  }
  g_stop = 1;
  return NULL;
}

static void start_control_thread(void) {
#if defined(_WIN32)
  HANDLE thread = CreateThread(NULL, 0, (LPTHREAD_START_ROUTINE)control_thread_main, NULL, 0, NULL);
  if (thread) CloseHandle(thread);
#else
  pthread_t thread;
  if (pthread_create(&thread, NULL, control_thread_main, NULL) == 0) pthread_detach(thread);
#endif
}


#define SPECTRUM_N 1024
#define SPECTRUM_BANDS 48

typedef struct { float smooth[SPECTRUM_BANDS]; } SpectrumState;

static void spectrum_fft(float *re, float *im) {
  for (int i = 1, j = 0; i < SPECTRUM_N; i++) {
    int bit = SPECTRUM_N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      float t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (int len = 2; len <= SPECTRUM_N; len <<= 1) {
    float ang = -6.28318530718f / (float)len;
    float wlen_r = cosf(ang), wlen_i = sinf(ang);
    for (int i = 0; i < SPECTRUM_N; i += len) {
      float wr = 1.0f, wi = 0.0f;
      for (int k = 0; k < len / 2; k++) {
        float ur = re[i + k], ui = im[i + k];
        float vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
        float vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        float nwr = wr * wlen_r - wi * wlen_i;
        wi = wr * wlen_i + wi * wlen_r;
        wr = nwr;
      }
    }
  }
}

static void emit_spectrum(const int32_t *pcm, int frames, int channels, int rate, SpectrumState *state) {
  if (!pcm || frames < SPECTRUM_N || channels < 1) return;
  float re[SPECTRUM_N], im[SPECTRUM_N];
  const int start = frames - SPECTRUM_N;
  for (int i = 0; i < SPECTRUM_N; i++) {
    const int32_t *frame = pcm + (size_t)(start + i) * (size_t)channels;
    float mono = (float)frame[0] / 2147483647.0f;
    if (channels > 1) mono = (mono + (float)frame[1] / 2147483647.0f) * 0.5f;
    const float hann = 0.5f - 0.5f * cosf(6.28318530718f * (float)i / (float)(SPECTRUM_N - 1));
    re[i] = mono * hann;
    im[i] = 0.0f;
  }
  spectrum_fft(re, im);
  char line[1024];
  int used = snprintf(line, sizeof(line), "{\"event\":\"spectrum\",\"bands\":[");
  const float nyquist = (float)rate * 0.5f;
  const float top = fminf(16000.0f, nyquist * 0.95f);
  float raw[SPECTRUM_BANDS];
  float maximum = 0.0f;
  for (int b = 0; b < SPECTRUM_BANDS; b++) {
    const float f0 = 30.0f * powf(top / 30.0f, (float)b / (float)SPECTRUM_BANDS);
    const float f1 = 30.0f * powf(top / 30.0f, (float)(b + 1) / (float)SPECTRUM_BANDS);
    int k0 = (int)(f0 / nyquist * (SPECTRUM_N / 2));
    int k1 = (int)(f1 / nyquist * (SPECTRUM_N / 2));
    if (k0 < 1) k0 = 1;
    if (k1 <= k0) k1 = k0 + 1;
    if (k1 > SPECTRUM_N / 2) k1 = SPECTRUM_N / 2;
    float mag = 0.0f;
    for (int k = k0; k < k1; k++) {
      const float m = sqrtf(re[k] * re[k] + im[k] * im[k]) / (float)SPECTRUM_N;
      if (m > mag) mag = m;
    }
    const float center = sqrtf(f0 * f1);
    const float tilt = powf(fmaxf(center, 80.0f) / 1000.0f, 0.45f);
    const float db = 20.0f * log10f(mag * tilt + 1e-7f);
    float value = (db + 62.0f) / 62.0f;
    if (value < 0.0f) value = 0.0f;
    if (value > 1.0f) value = 1.0f;
    raw[b] = value;
    if (value > maximum) maximum = value;
  }
  const float gain = maximum > 0.25f ? 0.78f / maximum : 1.0f;
  for (int b = 0; b < SPECTRUM_BANDS; b++) {
    const float value = raw[b] * gain;
    state->smooth[b] = value > state->smooth[b] ? value : state->smooth[b] * 0.55f;
    used += snprintf(line + used, sizeof(line) - (size_t)used, "%s%.3f", b ? "," : "", state->smooth[b]);
    if (used > (int)sizeof(line) - 16) break;
  }
  snprintf(line + used, sizeof(line) - (size_t)used, "]}");
  emit_line(line);
}


int naoe_play_file(const char *path, const char *backend_name, int start_ms, int growing, const char *done_path, int exclusive, int bits, const char *device, int hrtf) {
  const NaoeBackend *backend = NULL;
  if (naoe_backend_select(backend_name, &backend) != 0) {
    emit_line("{\"event\":\"error\",\"code\":\"BAD_BACKEND\",\"message\":\"unknown backend\"}");
    return 2;
  }
  int is_mp3 = ends_with(path, ".mp3");
  drflac *flac = NULL;
  drmp3 mp3;
  memset(&mp3, 0, sizeof(mp3));
  int rate = 0, channels = 0;
  uint64_t total = 0;
  if (is_mp3) {
    if (!drmp3_init_file(&mp3, path, NULL)) {
      emit_line("{\"event\":\"error\",\"code\":\"OPEN_FAILED\",\"message\":\"MP3 打开失败\"}");
      return 3;
    }
    rate = (int)mp3.sampleRate;
    channels = (int)mp3.channels;
    total = drmp3_get_pcm_frame_count(&mp3);
  } else {
    if (growing) {
      GrowFile *g = (GrowFile *)calloc(1, sizeof(GrowFile));
      g->done_path = done_path;
      for (int attempt = 0; attempt < 500 && !g->file; attempt++) {
        g->file = fopen(path, "rb");
        if (!g->file) {
#if defined(_WIN32)
          Sleep(10);
#else
          naoe_sleep_ms(10);
#endif
        }
      }
      if (g->file) flac = drflac_open(grow_read, grow_seek, grow_tell, g, NULL);
      if (!flac) {
        emit_line("{\"event\":\"error\",\"code\":\"OPEN_FAILED\",\"message\":\"FLAC 流式打开失败\"}");
        return 3;
      }
    } else {
      flac = drflac_open_file(path, NULL);
    }
    if (!flac) {
      emit_line("{\"event\":\"error\",\"code\":\"OPEN_FAILED\",\"message\":\"FLAC 打开失败\"}");
      return 3;
    }
    rate = (int)flac->sampleRate;
    channels = (int)flac->channels;
    total = flac->totalPCMFrameCount;
  }
  if (channels < 1) channels = 2;
  if (channels > 32) channels = 32;
  const int source_channels = channels;
  const int output_channels = hrtf && source_channels > 2 ? 2 : source_channels;

  HrtfState hrtf_state;
  memset(&hrtf_state, 0, sizeof(hrtf_state));
  if (hrtf) {
    hrtf_state.size = rate / 4000;
    if (hrtf_state.size < 4) hrtf_state.size = 4;
    if (hrtf_state.size > 128) hrtf_state.size = 128;
    hrtf_state.left = (float *)calloc((size_t)hrtf_state.size, sizeof(float));
    hrtf_state.right = (float *)calloc((size_t)hrtf_state.size, sizeof(float));
    if (!hrtf_state.left || !hrtf_state.right) hrtf = 0;
  }

  NaoeConfig cfg;
  memset(&cfg, 0, sizeof(cfg));
  snprintf(cfg.device, sizeof(cfg.device), "%s", device && *device ? device : "default");
  cfg.sample_rate = rate;
  cfg.channels = output_channels;
  cfg.bits = bits == 16 ? 16 : 32;
  snprintf(cfg.sample_format, sizeof(cfg.sample_format), "%s", cfg.bits == 16 ? "s16le" : "s32le");
  cfg.exclusive = exclusive ? 1 : 0;
  cfg.buffer_ms = 100;
  cfg.volume = 1.0;

  NaoeFormat actual;
  int buffer_frames = 0;
  void *handle = NULL;
  char err[256] = {0};
  char supported[4096] = {0};
  if (backend->open(&cfg, &actual, &buffer_frames, &handle, err, sizeof(err), supported,
                    sizeof(supported)) != 0) {
    char esc[512];
    naoe_json_escape(err, esc, sizeof(esc));
    char line[768];
    snprintf(line, sizeof(line), "{\"event\":\"error\",\"code\":\"OPEN_FAILED\",\"message\":\"%s\"}", esc);
    emit_line(line);
    return 4;
  }
  char line[512];
  snprintf(line, sizeof(line),
           "{\"event\":\"ready\",\"version\":\"" NAOE_VERSION "\",\"protocol\":\"" NAOE_PROTOCOL "\"}");
  emit_line(line);
  snprintf(line, sizeof(line),
           "{\"event\":\"configured\",\"device\":{\"id\":\"default\",\"name\":\"default\",\"backend\":\"%s\","
           "\"isDefault\":true,\"formats\":[{\"sampleRate\":%d,\"bits\":32,\"channels\":%d,"
           "\"sampleFormat\":\"s32le\"}]},\"format\":{\"sampleRate\":%d,\"bits\":32,\"channels\":%d,"
           "\"sampleFormat\":\"s32le\"},\"bufferFrames\":%d,\"exclusive\":true}",
           backend->name, rate, output_channels, rate, output_channels, buffer_frames);
  emit_line(line);
  emit_line("{\"event\":\"started\"}");
  start_control_thread();
  if (start_ms > 0) {
    uint64_t frame = (uint64_t)((double)rate * start_ms / 1000.0);
    if (is_mp3) drmp3_seek_to_pcm_frame(&mp3, frame);
    else drflac_seek_to_pcm_frame(flac, frame);
  }

  const int chunk_frames = 4096;
  int32_t *pcm = (int32_t *)malloc((size_t)chunk_frames * (size_t)source_channels * sizeof(int32_t));
  int16_t *pcm16 = cfg.bits == 16 ? (int16_t *)malloc((size_t)chunk_frames * (size_t)output_channels * sizeof(int16_t)) : NULL;
  int32_t *downmix = hrtf && source_channels > 2 ? (int32_t *)malloc((size_t)chunk_frames * 2u * sizeof(int32_t)) : NULL;
  float *tmp = is_mp3 ? (float *)malloc((size_t)chunk_frames * (size_t)source_channels * sizeof(float)) : NULL;
  SpectrumState spectrum_state;
  memset(&spectrum_state, 0, sizeof(spectrum_state));
  if (!pcm || (cfg.bits == 16 && !pcm16) || (hrtf && source_channels > 2 && !downmix) || (is_mp3 && !tmp)) {
    emit_line("{\"event\":\"error\",\"code\":\"NOMEM\",\"message\":\"内存不足\"}");
    return 5;
  }
  uint64_t played = 0;
  uint64_t last_report = naoe_now_ms();
  int failed = 0;
  int paused_state = 0;
  for (;;) {
    if (g_stop) break;
    if (g_seek_requested) {
      g_seek_requested = 0;
      uint64_t frame = (uint64_t)((double)rate * (double)g_seek_ms / 1000.0);
      if (total && frame > total) frame = total;
      int ok = is_mp3 ? drmp3_seek_to_pcm_frame(&mp3, frame) : drflac_seek_to_pcm_frame(flac, frame);
      if (!ok) {
        emit_line("{\"event\":\"error\",\"code\":\"SEEK_FAILED\",\"message\":\"无法跳转到目标位置\"}");
      }
      if (backend->flush) backend->flush(handle);
      hrtf_reset(&hrtf_state);
      played = 0;
      last_report = naoe_now_ms();
      char seeked[128];
      snprintf(seeked, sizeof(seeked),
               "{\"event\":\"seeked\",\"ms\":%d,\"ok\":%s}", g_seek_ms, ok ? "true" : "false");
      emit_line(seeked);
      continue;
    }
    if (g_pause != paused_state) {
      paused_state = g_pause;
      if (backend->pause) backend->pause(handle, paused_state);
    }
    if (paused_state) {
      naoe_sleep_ms(10);
      continue;
    }
    uint64_t got = 0;
    if (is_mp3) {
      got = drmp3_read_pcm_frames_f32(&mp3, chunk_frames, tmp);
      for (uint64_t i = 0; i < got * (uint64_t)source_channels; i++) {
        double v = tmp[i];
        if (v > 1.0) v = 1.0;
        if (v < -1.0) v = -1.0;
        pcm[i] = (int32_t)(v * 2147483647.0);
      }
    } else {
      got = drflac_read_pcm_frames_s32(flac, chunk_frames, pcm);
    }
    if (got == 0) break;
    int32_t *processed = pcm;
    if (hrtf && source_channels > 2 && downmix) {
      downmix_to_stereo(pcm, (int)got, source_channels, downmix);
      hrtf_process(downmix, (int)got, 2, rate, &hrtf_state);
      processed = downmix;
    } else if (hrtf) {
      hrtf_process(pcm, (int)got, source_channels, rate, &hrtf_state);
    }
    if (g_volume < 0.999f) {
      for (uint64_t i = 0; i < got * (uint64_t)output_channels; i++) {
        processed[i] = (int32_t)((float)processed[i] * g_volume);
      }
    }
    void *payload = processed;
    if (cfg.bits == 16) {
      for (uint64_t i = 0; i < got * (uint64_t)output_channels; i++) pcm16[i] = (int16_t)((uint32_t)processed[i] >> 16);
      payload = pcm16;
    }
    emit_spectrum(processed, (int)got, output_channels, rate, &spectrum_state);
    if (!backend->write_int || backend->write_int(handle, payload, (int)got, cfg.bits) < 0) {
      failed = 1;
      break;
    }
    played += got;
    uint64_t now = naoe_now_ms();
    if (now - last_report >= 120) {
      uint64_t device_played = played;
      if (backend->position && backend->position(handle, &device_played) == 0) {
        /* use frames actually consumed by the device, not decoded-ahead frames */
      }
      char progress[192];
      snprintf(progress, sizeof(progress),
               "{\"event\":\"progress\",\"frames\":%llu,\"playedFrames\":%llu}",
               (unsigned long long)played, (unsigned long long)device_played);
      emit_line(progress);
      last_report = now;
    }
  }
  if (!failed && backend->drain) backend->drain(handle);
  emit_line("{\"event\":\"drained\"}");
  free(pcm);
  if (pcm16) free(pcm16);
  if (tmp) free(tmp);
  if (backend->close) backend->close(handle);
  if (downmix) free(downmix);
  if (hrtf_state.left) free(hrtf_state.left);
  if (hrtf_state.right) free(hrtf_state.right);
  if (is_mp3) drmp3_uninit(&mp3);
  else drflac_close(flac);
  (void)total;
  return 0;
}
