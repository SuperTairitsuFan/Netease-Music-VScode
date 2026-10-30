/* Native streaming file playback: decode FLAC/MP3 as we play. */
#include "naoe.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define DR_FLAC_IMPLEMENTATION
#define DR_MP3_IMPLEMENTATION
#define DR_FLAC_NO_OGG
#include "dr_flac.h"
#include "dr_mp3.h"

static void emit_line(const char *line) {
  fputs(line, stdout);
  fputc('\n', stdout);
  fflush(stdout);
}

static int ends_with(const char *s, const char *suffix) {
  size_t n = strlen(s), m = strlen(suffix);
  return n >= m && _stricmp(s + n - m, suffix) == 0;
}

int naoe_play_file(const char *path, const char *backend_name, int start_ms) {
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
    flac = drflac_open_file(path, NULL);
    if (!flac) {
      emit_line("{\"event\":\"error\",\"code\":\"OPEN_FAILED\",\"message\":\"FLAC 打开失败\"}");
      return 3;
    }
    rate = (int)flac->sampleRate;
    channels = (int)flac->channels;
    total = flac->totalPCMFrameCount;
  }
  if (channels < 1) channels = 2;
  if (channels > 2) channels = 2;

  NaoeConfig cfg;
  memset(&cfg, 0, sizeof(cfg));
  snprintf(cfg.device, sizeof(cfg.device), "default");
  cfg.sample_rate = rate;
  cfg.channels = channels;
  cfg.bits = 32;
  snprintf(cfg.sample_format, sizeof(cfg.sample_format), "s32le");
  cfg.exclusive = 1;
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
  if (start_ms > 0) {
    uint64_t frame = (uint64_t)((double)rate * start_ms / 1000.0);
    if (is_mp3) drmp3_seek_to_pcm_frame(&mp3, frame);
    else drflac_seek_to_pcm_frame(flac, frame);
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
           backend->name, rate, channels, rate, channels, buffer_frames);
  emit_line(line);
  emit_line("{\"event\":\"started\"}");

  const int chunk_frames = 4096;
  int32_t *pcm = (int32_t *)malloc((size_t)chunk_frames * (size_t)channels * sizeof(int32_t));
  float *tmp = is_mp3 ? (float *)malloc((size_t)chunk_frames * (size_t)channels * sizeof(float)) : NULL;
  if (!pcm || (is_mp3 && !tmp)) {
    emit_line("{\"event\":\"error\",\"code\":\"NOMEM\",\"message\":\"内存不足\"}");
    return 5;
  }
  uint64_t played = 0;
  uint64_t last_report = naoe_now_ms();
  int failed = 0;
  for (;;) {
    uint64_t got = 0;
    if (is_mp3) {
      got = drmp3_read_pcm_frames_f32(&mp3, chunk_frames, tmp);
      for (uint64_t i = 0; i < got * (uint64_t)channels; i++) {
        double v = tmp[i];
        if (v > 1.0) v = 1.0;
        if (v < -1.0) v = -1.0;
        pcm[i] = (int32_t)(v * 2147483647.0);
      }
    } else {
      got = drflac_read_pcm_frames_s32(flac, chunk_frames, pcm);
    }
    if (got == 0) break;
    if (!backend->write_int || backend->write_int(handle, pcm, (int)got, 32) < 0) {
      failed = 1;
      break;
    }
    played += got;
    uint64_t now = naoe_now_ms();
    if (now - last_report >= 120) {
      char progress[192];
      snprintf(progress, sizeof(progress),
               "{\"event\":\"progress\",\"frames\":%llu,\"playedFrames\":%llu}",
               (unsigned long long)played, (unsigned long long)played);
      emit_line(progress);
      last_report = now;
    }
  }
  if (!failed && backend->drain) backend->drain(handle);
  emit_line("{\"event\":\"drained\"}");
  free(pcm);
  if (tmp) free(tmp);
  if (backend->close) backend->close(handle);
  if (is_mp3) drmp3_uninit(&mp3);
  else drflac_close(flac);
  (void)total;
  return 0;
}
