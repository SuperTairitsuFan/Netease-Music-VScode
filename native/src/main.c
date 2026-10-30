#include "naoe.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#include <windows.h>
#else
#include <pthread.h>
#endif

#if defined(__linux__)
#include <unistd.h>
#endif

/* ------------------------------------------------------------------ ring */

#define RING_SAMPLES (4u * 1024u * 1024u)

#ifdef _WIN32
typedef SRWLOCK naoe_mutex;
typedef CONDITION_VARIABLE naoe_cond;
static void mutex_init(naoe_mutex *m) { InitializeSRWLock(m); }
static void mutex_lock(naoe_mutex *m) { AcquireSRWLockExclusive(m); }
static void mutex_unlock(naoe_mutex *m) { ReleaseSRWLockExclusive(m); }
static void cond_init(naoe_cond *c) { InitializeConditionVariable(c); }
static void cond_wait(naoe_cond *c, naoe_mutex *m) { SleepConditionVariableSRW(c, m, INFINITE, 0); }
static void cond_signal(naoe_cond *c) { WakeConditionVariable(c); }
static void cond_broadcast(naoe_cond *c) { WakeAllConditionVariable(c); }
#else
typedef pthread_mutex_t naoe_mutex;
typedef pthread_cond_t naoe_cond;
static void mutex_init(naoe_mutex *m) { pthread_mutex_init(m, NULL); }
static void mutex_lock(naoe_mutex *m) { pthread_mutex_lock(m); }
static void mutex_unlock(naoe_mutex *m) { pthread_mutex_unlock(m); }
static void cond_init(naoe_cond *c) { pthread_cond_init(c, NULL); }
static void cond_wait(naoe_cond *c, naoe_mutex *m) { pthread_cond_wait(c, m); }
static void cond_signal(naoe_cond *c) { pthread_cond_signal(c); }
static void cond_broadcast(naoe_cond *c) { pthread_cond_broadcast(c); }
#endif

typedef struct {
  float *data;
  size_t capacity;
  size_t head;
  size_t tail;
  size_t count;
  int ended;
  int stop;
  naoe_mutex mutex;
  naoe_cond not_empty;
  naoe_cond not_full;
} Ring;

static void ring_init(Ring *ring) {
  ring->data = (float *)calloc(RING_SAMPLES, sizeof(float));
  ring->capacity = RING_SAMPLES;
  ring->head = ring->tail = ring->count = 0;
  ring->ended = ring->stop = 0;
  mutex_init(&ring->mutex);
  cond_init(&ring->not_empty);
  cond_init(&ring->not_full);
}

static void ring_free(Ring *ring) { free(ring->data); }

static int ring_push(Ring *ring, const float *samples, size_t count) {
  mutex_lock(&ring->mutex);
  for (size_t i = 0; i < count;) {
    while (ring->count == ring->capacity && !ring->stop) cond_wait(&ring->not_full, &ring->mutex);
    if (ring->stop) {
      mutex_unlock(&ring->mutex);
      return -1;
    }
    size_t space = ring->capacity - ring->count;
    size_t chunk = count - i < space ? count - i : space;
    size_t first = ring->capacity - ring->tail;
    if (first > chunk) first = chunk;
    memcpy(ring->data + ring->tail, samples + i, first * sizeof(float));
    if (chunk > first) memcpy(ring->data, samples + i + first, (chunk - first) * sizeof(float));
    ring->tail = (ring->tail + chunk) % ring->capacity;
    ring->count += chunk;
    i += chunk;
  }
  cond_signal(&ring->not_empty);
  mutex_unlock(&ring->mutex);
  return 0;
}

/* Returns number of samples copied, or -1 when the stream is finished. */
static int ring_pop(Ring *ring, float *out, size_t max_samples) {
  mutex_lock(&ring->mutex);
  while (ring->count == 0 && !ring->ended && !ring->stop) cond_wait(&ring->not_empty, &ring->mutex);
  if (ring->stop || (ring->count == 0 && ring->ended)) {
    mutex_unlock(&ring->mutex);
    return -1;
  }
  size_t take = ring->count < max_samples ? ring->count : max_samples;
  size_t first = ring->capacity - ring->head;
  if (first > take) first = take;
  memcpy(out, ring->data + ring->head, first * sizeof(float));
  if (take > first) memcpy(out + first, ring->data, (take - first) * sizeof(float));
  ring->head = (ring->head + take) % ring->capacity;
  ring->count -= take;
  cond_signal(&ring->not_full);
  mutex_unlock(&ring->mutex);
  return (int)take;
}

static void ring_clear(Ring *ring) {
  mutex_lock(&ring->mutex);
  ring->head = ring->tail = ring->count = 0;
  cond_broadcast(&ring->not_full);
  mutex_unlock(&ring->mutex);
}

static void ring_finish(Ring *ring) {
  mutex_lock(&ring->mutex);
  ring->ended = 1;
  cond_broadcast(&ring->not_empty);
  cond_broadcast(&ring->not_full);
  mutex_unlock(&ring->mutex);
}

static void ring_stop(Ring *ring) {
  mutex_lock(&ring->mutex);
  ring->stop = 1;
  cond_broadcast(&ring->not_empty);
  cond_broadcast(&ring->not_full);
  mutex_unlock(&ring->mutex);
}

/* ------------------------------------------------------------------ output */

static naoe_mutex g_out_mutex;
static int g_out_ready = 0;

static void out_init(void) {
  if (!g_out_ready) {
    mutex_init(&g_out_mutex);
    g_out_ready = 1;
  }
}

static void send_line(const char *line) {
  out_init();
  mutex_lock(&g_out_mutex);
  fputs(line, stdout);
  fputc('\n', stdout);
  fflush(stdout);
  mutex_unlock(&g_out_mutex);
}

static void send_error(const char *code, const char *message, const char *supported_json) {
  char esc_code[128];
  char esc_msg[2048];
  char line[8192];
  naoe_json_escape(code, esc_code, sizeof(esc_code));
  naoe_json_escape(message, esc_msg, sizeof(esc_msg));
  snprintf(line, sizeof(line), "{\"event\":\"error\",\"code\":\"%s\",\"message\":\"%s\"%s%s%s}", esc_code,
           esc_msg, supported_json && *supported_json ? ",\"supported\":" : "",
           supported_json && *supported_json ? supported_json : "",
           supported_json && *supported_json ? "" : "");
  send_line(line);
}

static void send_format(const NaoeFormat *format) {
  char esc[16];
  naoe_json_escape(format->sample_format, esc, sizeof(esc));
  char line[256];
  snprintf(line, sizeof(line),
           "{\"sampleRate\":%d,\"bits\":%d,\"channels\":%d,\"sampleFormat\":\"%s\"}", format->sample_rate,
           format->bits, format->channels, esc);
  send_line(line);
}

/* ------------------------------------------------------------------ json */

static const char *json_value(const char *json, const char *key) {
  char pattern[96];
  snprintf(pattern, sizeof(pattern), "\"%s\"", key);
  const char *p = strstr(json, pattern);
  if (!p) return NULL;
  p += strlen(pattern);
  while (*p && isspace((unsigned char)*p)) p++;
  if (*p != ':') return NULL;
  p++;
  while (*p && isspace((unsigned char)*p)) p++;
  return p;
}

static int json_string(const char *json, const char *key, char *out, size_t out_len) {
  const char *p = json_value(json, key);
  if (!p || *p != '"') return 0;
  p++;
  size_t o = 0;
  while (*p && *p != '"' && o + 1 < out_len) {
    if (*p == '\\' && p[1]) {
      p++;
      switch (*p) {
        case 'n':
          out[o++] = '\n';
          break;
        case 't':
          out[o++] = '\t';
          break;
        case 'r':
          out[o++] = '\r';
          break;
        default:
          out[o++] = *p;
      }
      p++;
    } else {
      out[o++] = *p++;
    }
  }
  out[o] = '\0';
  return 1;
}

static int json_int(const char *json, const char *key, int fallback) {
  const char *p = json_value(json, key);
  if (!p) return fallback;
  return (int)strtol(p, NULL, 10);
}

static double json_double(const char *json, const char *key, double fallback) {
  const char *p = json_value(json, key);
  if (!p) return fallback;
  return strtod(p, NULL);
}

static int json_bool(const char *json, const char *key, int fallback) {
  const char *p = json_value(json, key);
  if (!p) return fallback;
  if (strncmp(p, "true", 4) == 0) return 1;
  if (strncmp(p, "false", 5) == 0) return 0;
  return fallback;
}

/* ------------------------------------------------------------------ pump */

typedef struct {
  const NaoeBackend *backend;
  void *handle;
  Ring *ring;
  NaoeFormat format;
  int buffer_frames;
  volatile int paused;
  volatile int finished;
} Pump;

#ifdef _WIN32
static DWORD WINAPI pump_main(LPVOID arg)
#else
static void *pump_main(void *arg)
#endif
{
  Pump *pump = (Pump *)arg;
  int chunk_frames = pump->buffer_frames > 0 ? pump->buffer_frames : 1024;
  if (chunk_frames > 16384) chunk_frames = 16384;
  float *buffer = (float *)malloc((size_t)chunk_frames * (size_t)pump->format.channels * sizeof(float));
  uint64_t written = 0;
  uint64_t last_report = naoe_now_ms();
  int failed = 0;

  while (!pump->finished) {
    if (pump->paused) {
      naoe_sleep_ms(5);
      continue;
    }
    int samples = ring_pop(pump->ring, buffer, (size_t)chunk_frames * (size_t)pump->format.channels);
    if (samples < 0) break;
    int frames = samples / pump->format.channels;
    int ok = pump->backend->write(pump->handle, buffer, frames);
    if (ok < 0) {
      if (ok == -2) {
        send_line("{\"event\":\"deviceLost\",\"message\":\"音频设备已断开\"}");
      } else {
        send_line("{\"event\":\"underrun\",\"message\":\"音频设备写入失败，已尝试恢复\"}");
      }
      failed = ok == -2;
      if (failed) break;
      continue;
    }
    written += (uint64_t)ok;
    uint64_t now = naoe_now_ms();
    if (now - last_report >= 120) {
      uint64_t played = written;
      if (pump->backend->position) {
        uint64_t pos = 0;
        if (pump->backend->position(pump->handle, &pos) == 0) played = pos;
      }
      char line[192];
      snprintf(line, sizeof(line), "{\"event\":\"progress\",\"frames\":%llu,\"playedFrames\":%llu}",
               (unsigned long long)played, (unsigned long long)played);
      send_line(line);
      last_report = now;
    }
  }

  if (!failed && pump->backend->drain) {
    pump->backend->drain(pump->handle);
    send_line("{\"event\":\"drained\"}");
  }
  free(buffer);
#ifdef _WIN32
  return 0;
#else
  return NULL;
#endif
}

/* ------------------------------------------------------------------ serve */

typedef struct {
  const NaoeBackend *backend;
  void *handle;
  NaoeFormat format;
  int buffer_frames;
  int configured;
  int started;
  Ring ring;
  Pump pump;
#ifdef _WIN32
  HANDLE thread;
#else
  pthread_t thread;
#endif
  int thread_started;
} Engine;

static void emit_configured(Engine *engine, const NaoeConfig *cfg) {
  char device[1024];
  char format[256];
  char line[2048];
  naoe_json_escape(cfg->device, device, sizeof(device));
  char sf[16];
  naoe_json_escape(engine->format.sample_format, sf, sizeof(sf));
  snprintf(format, sizeof(format),
           "{\"sampleRate\":%d,\"bits\":%d,\"channels\":%d,\"sampleFormat\":\"%s\"}",
           engine->format.sample_rate, engine->format.bits, engine->format.channels, sf);
  snprintf(line, sizeof(line),
           "{\"event\":\"configured\",\"device\":{\"id\":\"%s\",\"name\":\"%s\",\"backend\":\"%s\","
           "\"isDefault\":%s,\"formats\":[%s]},\"format\":%s,\"bufferFrames\":%d,\"exclusive\":%s}",
           device, device, engine->backend->name, strcmp(cfg->device, "default") == 0 ? "true" : "false",
           format, format, engine->buffer_frames, cfg->exclusive ? "true" : "false");
  send_line(line);
}

static int do_configure(Engine *engine, const char *json) {
  if (engine->configured) {
    send_error("ALREADY_CONFIGURED", "引擎已经配置，需重新启动进程", NULL);
    return -1;
  }
  NaoeConfig cfg;
  memset(&cfg, 0, sizeof(cfg));
  if (!json_string(json, "device", cfg.device, sizeof(cfg.device)) || !cfg.device[0]) {
    strcpy(cfg.device, "default");
  }
  cfg.sample_rate = json_int(json, "sampleRate", 48000);
  cfg.channels = json_int(json, "channels", 2);
  cfg.bits = json_int(json, "bits", 32);
  cfg.buffer_ms = json_int(json, "bufferMs", 10);
  cfg.exclusive = json_bool(json, "exclusive", 0);
  cfg.volume = json_double(json, "volume", 1.0);
  if (!json_string(json, "sampleFormat", cfg.sample_format, sizeof(cfg.sample_format)) || !cfg.sample_format[0]) {
    strcpy(cfg.sample_format, "f32le");
  }
  if (cfg.channels < 1 || cfg.channels > 8) {
    send_error("INVALID_CONFIG", "声道数必须在 1..8 之间", NULL);
    return -1;
  }
  if (cfg.sample_rate < 8000 || cfg.sample_rate > 384000) {
    send_error("INVALID_CONFIG", "采样率必须在 8000..384000 Hz 之间", NULL);
    return -1;
  }
  if (cfg.buffer_ms < 1 || cfg.buffer_ms > 500) cfg.buffer_ms = 10;

  char err[512] = {0};
  char supported[4096] = {0};
  engine->format.sample_rate = cfg.sample_rate;
  engine->format.channels = cfg.channels;
  engine->format.bits = cfg.bits;
  strncpy(engine->format.sample_format, cfg.sample_format, sizeof(engine->format.sample_format) - 1);
  if (engine->backend->open(&cfg, &engine->format, &engine->buffer_frames, &engine->handle, err,
                            sizeof(err), supported, sizeof(supported)) != 0) {
    send_error(err[0] ? err : "OPEN_FAILED", err[0] ? err : "无法打开音频设备", supported);
    return -1;
  }
  engine->configured = 1;
  emit_configured(engine, &cfg);
  return 0;
}

static int do_start(Engine *engine) {
  if (!engine->configured) {
    send_error("NOT_CONFIGURED", "请先发送 configure 命令", NULL);
    return -1;
  }
  if (engine->started) return 0;
  engine->pump.backend = engine->backend;
  engine->pump.handle = engine->handle;
  engine->pump.ring = &engine->ring;
  engine->pump.format = engine->format;
  engine->pump.buffer_frames = engine->buffer_frames;
  engine->pump.paused = 0;
  engine->pump.finished = 0;
#ifdef _WIN32
  engine->thread = CreateThread(NULL, 0, pump_main, &engine->pump, 0, NULL);
  if (!engine->thread) {
    send_error("THREAD_FAILED", "无法创建音频线程", NULL);
    return -1;
  }
#else
  if (pthread_create(&engine->thread, NULL, pump_main, &engine->pump) != 0) {
    send_error("THREAD_FAILED", "无法创建音频线程", NULL);
    return -1;
  }
#endif
  engine->thread_started = 1;
  engine->started = 1;
  send_line("{\"event\":\"started\"}");
  return 0;
}

static void engine_join(Engine *engine) {
  if (!engine->thread_started) return;
  engine->pump.finished = 0;
  ring_finish(&engine->ring);
#ifdef _WIN32
  WaitForSingleObject(engine->thread, INFINITE);
  CloseHandle(engine->thread);
#else
  pthread_join(engine->thread, NULL);
#endif
  engine->thread_started = 0;
}

static int read_exact(void *buffer, size_t length) {
  unsigned char *p = (unsigned char *)buffer;
  size_t got = 0;
  while (got < length) {
    size_t n = fread(p + got, 1, length - got, stdin);
    if (n == 0) return got == 0 ? 0 : -1;
    got += n;
  }
  return 1;
}

static int handle_control(Engine *engine, const char *json) {
  char cmd[64];
  if (!json_string(json, "cmd", cmd, sizeof(cmd))) return 0;
  if (strcmp(cmd, "configure") == 0) return do_configure(engine, json);
  if (strcmp(cmd, "start") == 0) return do_start(engine);
  if (strcmp(cmd, "pause") == 0) {
    engine->pump.paused = 1;
    if (engine->backend->pause) engine->backend->pause(engine->handle, 1);
    send_line("{\"event\":\"paused\"}");
    return 0;
  }
  if (strcmp(cmd, "resume") == 0) {
    engine->pump.paused = 0;
    if (engine->backend->pause) engine->backend->pause(engine->handle, 0);
    send_line("{\"event\":\"resumed\"}");
    return 0;
  }
  if (strcmp(cmd, "volume") == 0) {
    double value = json_double(json, "value", 1.0);
    if (value < 0) value = 0;
    if (value > 1) value = 1;
    if (engine->backend->volume) engine->backend->volume(engine->handle, value);
    return 0;
  }
  if (strcmp(cmd, "flush") == 0) {
    ring_clear(&engine->ring);
    if (engine->backend->flush) engine->backend->flush(engine->handle);
    send_line("{\"event\":\"flushed\"}");
    return 0;
  }
  if (strcmp(cmd, "stop") == 0) {
    ring_stop(&engine->ring);
    return 1;
  }
  send_error("UNKNOWN_COMMAND", "未知控制命令", NULL);
  return 0;
}

static int serve(const NaoeBackend *backend) {
  Engine engine;
  memset(&engine, 0, sizeof(engine));
  engine.backend = backend;
  ring_init(&engine.ring);
  send_line("{\"event\":\"ready\",\"version\":\"" NAOE_VERSION "\",\"protocol\":\"" NAOE_PROTOCOL "\"}");

  int stop_requested = 0;
  int stream_ended = 0;
  unsigned char header[5];

  while (!stop_requested) {
    int status = read_exact(header, 5);
    if (status == 0) {
      stream_ended = 1;
      break;
    }
    if (status < 0) {
      send_error("STREAM_ERROR", "读取 stdin 帧头失败", NULL);
      break;
    }
    uint32_t type = header[0];
    uint32_t length = (uint32_t)header[1] | ((uint32_t)header[2] << 8) | ((uint32_t)header[3] << 16) |
                      ((uint32_t)header[4] << 24);
    if (length > (64u * 1024u * 1024u)) {
      send_error("FRAME_TOO_LARGE", "帧长度超出上限", NULL);
      break;
    }
    if (type == NAOE_FRAME_CONTROL) {
      char *payload = (char *)malloc((size_t)length + 1);
      if (!payload) break;
      if (length && read_exact(payload, length) != 1) {
        free(payload);
        break;
      }
      payload[length] = '\0';
      int result = handle_control(&engine, payload);
      free(payload);
      if (result == 1) {
        stop_requested = 1;
        break;
      }
    } else if (type == NAOE_FRAME_PCM) {
      if (!engine.started) {
        send_error("NOT_STARTED", "PCM 数据在 start 之前到达", NULL);
        break;
      }
      if (!engine.configured || engine.format.channels <= 0) {
        send_error("NOT_CONFIGURED", "PCM 数据在 configure 之前到达", NULL);
        break;
      }
      if (length % (4u * (uint32_t)engine.format.channels) != 0) {
        send_error("INVALID_PCM", "PCM 字节数不是帧大小的整数倍", NULL);
        break;
      }
      float *payload = (float *)malloc(length ? length : 1);
      if (!payload) break;
      if (length && read_exact(payload, length) != 1) {
        free(payload);
        break;
      }
      size_t samples = length / 4u;
      if (ring_push(&engine.ring, payload, samples) != 0) {
        free(payload);
        break;
      }
      free(payload);
    } else if (type == NAOE_FRAME_END) {
      stream_ended = 1;
      break;
    } else {
      send_error("UNKNOWN_FRAME", "未知帧类型", NULL);
      break;
    }
  }

  if (stream_ended) {
    ring_finish(&engine.ring);
    if (engine.thread_started) engine_join(&engine);
  } else {
    ring_stop(&engine.ring);
    if (engine.thread_started) engine_join(&engine);
  }
  if (engine.handle && backend->close) backend->close(engine.handle);
  ring_free(&engine.ring);
  return 0;
}

static void set_binary_stdio(void) {
#ifdef _WIN32
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
#endif
}

int main(int argc, char **argv) {
  set_binary_stdio();
  const char *backend_name = getenv("NAOE_BACKEND");
  int mode_probe = 0;
  int mode_serve = 0;
  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--probe") == 0) mode_probe = 1;
    else if (strcmp(argv[i], "--serve") == 0) mode_serve = 1;
    else if (strcmp(argv[i], "--version") == 0) {
      printf("{\"version\":\"" NAOE_VERSION "\",\"protocol\":\"" NAOE_PROTOCOL "\"}\n");
      return 0;
    } else if (strcmp(argv[i], "--backend") == 0 && i + 1 < argc) backend_name = argv[++i];
    else if (strncmp(argv[i], "--backend=", 10) == 0) backend_name = argv[i] + 10;
  }

  const NaoeBackend *backend = NULL;
  if (naoe_backend_select(backend_name, &backend) != 0) {
    printf("{\"ok\":false,\"error\":\"unknown backend\"}\n");
    return 2;
  }

  if (mode_probe) {
    size_t capacity = 1u << 20;
    char *json = (char *)malloc(capacity);
    if (!json) return 3;
    int count = backend->probe ? backend->probe(backend, json, capacity) : -1;
    if (count < 0) {
      snprintf(json, capacity, "[]");
      count = 0;
    }
    printf("{\"ok\":true,\"version\":\"" NAOE_VERSION "\",\"protocol\":\"" NAOE_PROTOCOL "\","
           "\"backends\":[\"%s\"],\"devices\":%s}\n",
           backend->name, json);
    fflush(stdout);
    free(json);
    return 0;
  }
  if (mode_serve) return serve(backend);

  fprintf(stderr, "usage: %s --probe | --serve [--backend alsa|wasapi|null]\n", argv[0]);
  return 1;
}
