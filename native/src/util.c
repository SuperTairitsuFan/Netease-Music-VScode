#include "naoe.h"

#include <stdio.h>
#include <string.h>
#include <time.h>

#ifdef _WIN32
#include <windows.h>
#else
#include <errno.h>
#include <unistd.h>
#endif

extern const NaoeBackend naoe_alsa_backend;
extern const NaoeBackend naoe_wasapi_backend;
extern const NaoeBackend naoe_null_backend;

void naoe_json_escape(const char *input, char *output, size_t output_len) {
  size_t o = 0;
  if (output_len == 0) return;
  for (const unsigned char *p = (const unsigned char *)input; *p && o + 7 < output_len; p++) {
    switch (*p) {
      case '"':
      case '\\':
        output[o++] = '\\';
        output[o++] = (char)*p;
        break;
      case '\n':
        output[o++] = '\\';
        output[o++] = 'n';
        break;
      case '\r':
        output[o++] = '\\';
        output[o++] = 'r';
        break;
      case '\t':
        output[o++] = '\\';
        output[o++] = 't';
        break;
      default:
        if (*p < 0x20) {
          o += (size_t)snprintf(output + o, output_len - o, "\\u%04x", *p);
        } else {
          output[o++] = (char)*p;
        }
    }
  }
  output[o] = '\0';
}

uint64_t naoe_now_ms(void) {
#ifdef _WIN32
  return (uint64_t)GetTickCount64();
#else
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint64_t)ts.tv_sec * 1000u + (uint64_t)(ts.tv_nsec / 1000000);
#endif
}

void naoe_sleep_ms(int ms) {
  if (ms <= 0) return;
#ifdef _WIN32
  Sleep((DWORD)ms);
#else
  struct timespec ts;
  ts.tv_sec = ms / 1000;
  ts.tv_nsec = (long)(ms % 1000) * 1000000L;
  while (nanosleep(&ts, &ts) != 0 && errno == EINTR) {
  }
#endif
}

int naoe_backend_select(const char *name, const NaoeBackend **out) {
  if (!name || !*name) {
#ifdef _WIN32
    *out = &naoe_wasapi_backend;
#else
    *out = &naoe_alsa_backend;
#endif
    return 0;
  }
  if (strcmp(name, "null") == 0) {
    *out = &naoe_null_backend;
    return 0;
  }
  if (strcmp(name, "alsa") == 0) {
    *out = &naoe_alsa_backend;
    return 0;
  }
  if (strcmp(name, "wasapi") == 0) {
    *out = &naoe_wasapi_backend;
    return 0;
  }
  return -1;
}
