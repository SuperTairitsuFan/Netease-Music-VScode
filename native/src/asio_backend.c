/*
 * Optional ASIO backend (Windows only).
 *
 * TOPPING and many other USB DAC ASIO drivers are COM-only (they only export
 * DllGetClassObject). The COM class must live on an STA thread that pumps
 * Windows messages, and per the ASIO COM convention (NAudio et al.) the
 * driver CLSID is used as the interface IID for CoCreateInstance. The
 * returned object's vtable is IASIO with init() at slot 3.
 *
 * All COM calls happen on a dedicated STA thread which also pumps messages;
 * the engine thread only feeds a lock-protected int32 ring.
 */
#include "naoe.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)

#include <windows.h>
#include <objbase.h>
#include <winreg.h>
#include "asiosys.h"
#include "asio.h"

#define ASIO_RING_SAMPLES (1u << 20)
#define WM_ASIO_START (WM_APP + 1)
#define WM_ASIO_STOP (WM_APP + 2)
#define WM_ASIO_RESUME (WM_APP + 3)
#define WM_ASIO_OUTPUT_READY (WM_APP + 4)

typedef struct IASIO IASIO;
typedef struct IASIOVT {
  HRESULT (STDMETHODCALLTYPE *QueryInterface)(IASIO *, const IID *, void **);
  ULONG (STDMETHODCALLTYPE *AddRef)(IASIO *);
  ULONG (STDMETHODCALLTYPE *Release)(IASIO *);
  ASIOBool (STDMETHODCALLTYPE *init)(IASIO *, void *);
  void (STDMETHODCALLTYPE *getDriverName)(IASIO *, char *);
  long (STDMETHODCALLTYPE *getDriverVersion)(IASIO *);
  void (STDMETHODCALLTYPE *getErrorMessage)(IASIO *, char *);
  ASIOError (STDMETHODCALLTYPE *start)(IASIO *);
  ASIOError (STDMETHODCALLTYPE *stop)(IASIO *);
  ASIOError (STDMETHODCALLTYPE *getChannels)(IASIO *, long *, long *);
  ASIOError (STDMETHODCALLTYPE *getLatencies)(IASIO *, long *, long *);
  ASIOError (STDMETHODCALLTYPE *getBufferSize)(IASIO *, long *, long *, long *, long *);
  ASIOError (STDMETHODCALLTYPE *canSampleRate)(IASIO *, double);
  ASIOError (STDMETHODCALLTYPE *getSampleRate)(IASIO *, double *);
  ASIOError (STDMETHODCALLTYPE *setSampleRate)(IASIO *, double);
  ASIOError (STDMETHODCALLTYPE *getClockSources)(IASIO *, void *, long *);
  ASIOError (STDMETHODCALLTYPE *setClockSource)(IASIO *, long);
  ASIOError (STDMETHODCALLTYPE *getSamplePosition)(IASIO *, void *, void *);
  ASIOError (STDMETHODCALLTYPE *getChannelInfo)(IASIO *, ASIOChannelInfo *);
  ASIOError (STDMETHODCALLTYPE *createBuffers)(IASIO *, ASIOBufferInfo *, long, long, ASIOCallbacks *);
  ASIOError (STDMETHODCALLTYPE *disposeBuffers)(IASIO *);
  ASIOError (STDMETHODCALLTYPE *controlPanel)(IASIO *);
  ASIOError (STDMETHODCALLTYPE *future)(IASIO *, long, void *);
  ASIOError (STDMETHODCALLTYPE *outputReady)(IASIO *);
} IASIOVT;
struct IASIO {
  IASIOVT *lpVtbl;
};

typedef struct {
  IASIO *asio;
  IASIOVT *v;
  ASIOBufferInfo buffers[2];
  ASIOCallbacks callbacks;
  long buffer_frames;
  int channels;
  int sample_type;
  int started;
  volatile int paused;
  int dumped;
  uint64_t underruns;
  int32_t last_value;
  double gain;
  uint64_t written;
  CRITICAL_SECTION lock;
  int32_t *ring;
  size_t head;
  size_t tail;
  size_t count;
  HANDLE thread;
  DWORD thread_id;
  HANDLE ready_event;
  volatile LONG start_requested;
  volatile LONG stop_requested;
  volatile LONG quit;
  volatile LONG open_ok;
  char errbuf[256];
  int rate;
  int buffer_ms;
  wchar_t clsid[128];
} AsioHandle;

static AsioHandle *g_asio = NULL;

static void asio_buffer_switch(long index, ASIOBool direct) {
  (void)direct;
  AsioHandle *h = g_asio;
  if (!h || !h->started) return;
  EnterCriticalSection(&h->lock);
  long frames = h->buffer_frames;
  int type = h->sample_type;
  if (h->paused) {
    for (int ch = 0; ch < h->channels; ch++) {
      unsigned char *dst = (unsigned char *)h->buffers[ch].buffers[index];
      if (!dst) continue;
      memset(dst, 0, (size_t)frames * (type == ASIOSTInt16LSB ? 2u : type == ASIOSTInt24LSB ? 3u : 4u));
    }
    LeaveCriticalSection(&h->lock);
    if (h->thread_id) PostThreadMessageW(h->thread_id, WM_ASIO_OUTPUT_READY, 0, 0);
    return;
  }
  for (long i = 0; i < frames; i++) {
    for (int ch = 0; ch < h->channels; ch++) {
      unsigned char *dst = (unsigned char *)h->buffers[ch].buffers[index];
      if (!dst) continue;
      int32_t value = h->last_value;
      if (h->count > 0) {
        value = h->ring[h->head];
        h->head = (h->head + 1) % ASIO_RING_SAMPLES;
        h->count--;
        h->last_value = value;
      } else {
        h->underruns++;
      }
      switch (type) {
        case ASIOSTInt16LSB: {
          int16_t sample = (int16_t)((uint32_t)value >> 16);
          memcpy(dst + (size_t)i * 2, &sample, 2);
          break;
        }
        case ASIOSTInt24LSB: {
          uint32_t u = (uint32_t)value;
          dst[(size_t)i * 3 + 0] = (unsigned char)((u >> 8) & 0xff);
          dst[(size_t)i * 3 + 1] = (unsigned char)((u >> 16) & 0xff);
          dst[(size_t)i * 3 + 2] = (unsigned char)((u >> 24) & 0xff);
          break;
        }
        case ASIOSTFloat32LSB: {
          float sample = (float)(value / 2147483648.0);
          memcpy(dst + (size_t)i * 4, &sample, 4);
          break;
        }
        default: {
          int32_t sample = value;
          memcpy(dst + (size_t)i * 4, &sample, 4);
          break;
        }
      }
    }
  }
  h->written += (uint64_t)frames;
  LeaveCriticalSection(&h->lock);
  if (!h->dumped) {
    h->dumped = 1;
    char hex[512];
    int used = 0;
    for (int ch = 0; ch < h->channels && used < 480; ch++) {
      const int32_t *view = (const int32_t *)h->buffers[ch].buffers[index];
      used += snprintf(hex + used, sizeof(hex) - used, "ch%d:", ch);
      for (int i = 0; i < 8 && used < 480; i++) {
        used += snprintf(hex + used, sizeof(hex) - used, " %08x", view ? view[i] : 0);
      }
    }
    fprintf(stderr, "[asio] first buffer type=%d frames=%ld %s\n", h->sample_type, frames, hex);
  }
  if (h->underruns && ((h->written / (uint64_t)h->buffer_frames) % 100u) == 0u) {
    fprintf(stderr, "[asio] underrun frames=%llu\n", (unsigned long long)h->underruns);
  }
  /* outputReady is a COM call; ask the STA thread to make it. */
  if (h->thread_id) PostThreadMessageW(h->thread_id, WM_ASIO_OUTPUT_READY, 0, 0);
}

static void asio_sample_rate_changed(ASIOSampleRate rate) { (void)rate; }

static long asio_message(long selector, long value, void *message, double *opt) {
  (void)selector;
  (void)value;
  (void)message;
  (void)opt;
  return 0;
}

static ASIOTime *asio_buffer_switch_time_info(ASIOTime *time, long index, ASIOBool direct) {
  (void)time;
  asio_buffer_switch(index, direct);
  return NULL;
}

static int wide_to_utf8(const wchar_t *input, char *output, size_t output_len) {
  if (!input) return 0;
  int n = WideCharToMultiByte(CP_UTF8, 0, input, -1, output, (int)output_len - 1, NULL, NULL);
  if (n <= 0) output[0] = '\0';
  else output[output_len - 1] = '\0';
  return n > 0;
}

/* Enumerate the first registered ASIO driver. Returns 1 on success. */
static int find_asio_driver(wchar_t *clsid_out, size_t clsid_len, char *display_name, size_t name_len) {
  HKEY root = NULL;
  if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\ASIO", 0, KEY_READ | KEY_WOW64_64KEY, &root) !=
      ERROR_SUCCESS) {
    return 0;
  }
  int found = 0;
  for (DWORD index = 0; index < 16 && !found; index++) {
    wchar_t subkey[256];
    DWORD subkey_len = (DWORD)(sizeof(subkey) / sizeof(subkey[0]));
    if (RegEnumKeyExW(root, index, subkey, &subkey_len, NULL, NULL, NULL, NULL) != ERROR_SUCCESS) break;
    HKEY item = NULL;
    if (RegOpenKeyExW(root, subkey, 0, KEY_READ | KEY_WOW64_64KEY, &item) != ERROR_SUCCESS) continue;
    wchar_t clsid[128] = {0};
    DWORD clsid_len = sizeof(clsid) - sizeof(wchar_t);
    if (RegQueryValueExW(item, L"CLSID", NULL, NULL, (BYTE *)clsid, &clsid_len) == ERROR_SUCCESS &&
        clsid[0]) {
      wcsncpy(clsid_out, clsid, clsid_len / sizeof(wchar_t) - 1);
      wide_to_utf8(subkey, display_name, name_len);
      found = 1;
    }
    RegCloseKey(item);
  }
  RegCloseKey(root);
  return found;
}

static int asio_probe(const NaoeBackend *backend, char *json, size_t json_len) {
  (void)backend;
  wchar_t clsid[128] = {0};
  char name[256] = {0};
  if (!find_asio_driver(clsid, 128, name, sizeof(name))) {
    snprintf(json, json_len, "[]");
    return 0;
  }
  char esc[512];
  char clsid_utf8[128] = {0};
  wide_to_utf8(clsid, clsid_utf8, sizeof(clsid_utf8));
  naoe_json_escape(name, esc, sizeof(esc));
  snprintf(json, json_len,
           "[{\"id\":\"asio:%s\",\"name\":\"ASIO: %s\",\"backend\":\"asio\",\"isDefault\":true,"
           "\"formats\":[{\"sampleRate\":44100,\"bits\":32,\"channels\":2,\"sampleFormat\":\"s32le\"},"
           "{\"sampleRate\":48000,\"bits\":32,\"channels\":2,\"sampleFormat\":\"s32le\"},"
           "{\"sampleRate\":96000,\"bits\":32,\"channels\":2,\"sampleFormat\":\"s32le\"},"
           "{\"sampleRate\":192000,\"bits\":32,\"channels\":2,\"sampleFormat\":\"s32le\"}]}]",
           clsid_utf8, esc);
  return 1;
}

static void asio_fail(AsioHandle *h, const char *message) {
  snprintf(h->errbuf, sizeof(h->errbuf), "%s", message);
  h->open_ok = 0;
  SetEvent(h->ready_event);
}

static DWORD WINAPI asio_thread_main(LPVOID arg) {
  AsioHandle *h = (AsioHandle *)arg;
  HRESULT hr = CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
  if (FAILED(hr)) {
    asio_fail(h, "ASIO STA 线程 COM 初始化失败");
    return 1;
  }
  CLSID clsid;
  if (FAILED(CLSIDFromString(h->clsid, &clsid))) {
    asio_fail(h, "ASIO CLSID 无效");
    CoUninitialize();
    return 1;
  }
  void *raw = NULL;
  hr = CoCreateInstance(&clsid, NULL, CLSCTX_INPROC_SERVER, &clsid, &raw);
  if (FAILED(hr) || !raw) {
    asio_fail(h, "无法实例化 ASIO 驱动");
    CoUninitialize();
    return 1;
  }
  IASIO *asio = (IASIO *)raw;
  IASIOVT *v = asio->lpVtbl;
  h->asio = asio;
  h->v = v;

  if (!v->init(asio, NULL)) {
    char message[128] = {0};
    v->getErrorMessage(asio, message);
    asio_fail(h, message[0] ? message : "ASIOInit 失败");
    v->Release(asio);
    CoUninitialize();
    return 1;
  }

  long inputs = 0, outputs = 0;
  if (v->getChannels(asio, &inputs, &outputs) != ASE_OK || outputs < 2) {
    asio_fail(h, "ASIO 输出通道不足");
    v->Release(asio);
    CoUninitialize();
    return 1;
  }
  if (v->setSampleRate(asio, (double)h->rate) != ASE_OK) {
    asio_fail(h, "ASIO 不支持该采样率");
    v->Release(asio);
    CoUninitialize();
    return 1;
  }
  {
    double actual_rate = 0;
    v->getSampleRate(asio, &actual_rate);
    fprintf(stderr, "[asio] rate asked %d, driver reports %f\n", h->rate, actual_rate);
    ASIOClockSource clocks[8];
    memset(clocks, 0, sizeof(clocks));
    long num_sources = 8;
    if (v->getClockSources(asio, clocks, &num_sources) == ASE_OK) {
      for (long i = 0; i < num_sources && i < 8; i++) {
        fprintf(stderr, "[asio] clock[%ld] %s current=%d\n", i, clocks[i].name,
                (int)clocks[i].isCurrentSource);
        if (!clocks[i].isCurrentSource && (strstr(clocks[i].name, "Internal") ||
                                           strstr(clocks[i].name, "内部"))) {
          v->setClockSource(asio, clocks[i].index);
          fprintf(stderr, "[asio] clock switched to internal index %ld\n", clocks[i].index);
        }
      }
    }
  }
  long min_size = 0, max_size = 0, preferred = 0, granularity = 0;
  if (v->getBufferSize(asio, &min_size, &max_size, &preferred, &granularity) != ASE_OK || preferred <= 0) {
    asio_fail(h, "ASIOGetBufferSize 失败");
    v->Release(asio);
    CoUninitialize();
    return 1;
  }
  long buffer_size = preferred;
  if (h->buffer_ms > 0) {
    long wanted = (long)((int64_t)h->rate * h->buffer_ms / 1000);
    buffer_size = wanted;
    if (buffer_size < min_size) buffer_size = min_size;
    if (buffer_size > max_size) buffer_size = max_size;
    if (granularity > 1) buffer_size = ((buffer_size + granularity - 1) / granularity) * granularity;
    if (buffer_size < min_size) buffer_size = min_size;
  }
  if (preferred > 0 && preferred * 2 <= max_size && buffer_size < preferred * 2) buffer_size = preferred * 2;
  if (buffer_size > max_size) buffer_size = max_size;
  h->buffer_frames = buffer_size;

  for (int ch = 0; ch < 2; ch++) {
    ASIOChannelInfo channel;
    memset(&channel, 0, sizeof(channel));
    channel.channel = ch;
    channel.isInput = ASIOFalse;
    v->getChannelInfo(asio, &channel);
    if (ch == 0 && h->sample_type == 0) h->sample_type = channel.type;
    h->buffers[ch].isInput = ASIOFalse;
    h->buffers[ch].channelNum = ch;
    h->buffers[ch].buffers[0] = NULL;
    h->buffers[ch].buffers[1] = NULL;
  }
  /* Ask the driver for an unambiguous Float32 IO format when supported;
   * otherwise keep the channel-reported integer type. */
  {
    ASIOIoFormat io;
    memset(&io, 0, sizeof(io));
    io.FormatType = kASIOPCMFormat;
    v->future(asio, kAsioSetIoFormat, &io);
  }
  memset(&h->callbacks, 0, sizeof(h->callbacks));
  h->callbacks.bufferSwitch = asio_buffer_switch;
  h->callbacks.sampleRateDidChange = asio_sample_rate_changed;
  h->callbacks.asioMessage = asio_message;
  h->callbacks.bufferSwitchTimeInfo = asio_buffer_switch_time_info;
  if (v->createBuffers(asio, h->buffers, 2, buffer_size, &h->callbacks) != ASE_OK) {
    asio_fail(h, "ASIOCreateBuffers 失败");
    v->Release(asio);
    CoUninitialize();
    return 1;
  }
  fprintf(stderr, "[asio] sample type %d, buffer %ld frames\n", h->sample_type, buffer_size);
  h->open_ok = 1;
  SetEvent(h->ready_event);

  /* STA message pump: starts ASIO on demand and keeps COM callbacks alive. */
  MSG msg;
  while (!h->quit) {
    while (PeekMessageW(&msg, NULL, 0, 0, PM_REMOVE)) {
      if (msg.message == WM_QUIT) {
        h->quit = 1;
        break;
      }
      if (msg.message == WM_ASIO_START && !h->started) {
        if (v->start(asio) == ASE_OK) h->started = 1;
      } else if (msg.message == WM_ASIO_STOP && h->started) {
        v->stop(asio);
        h->started = 0;
      } else if (msg.message == WM_ASIO_RESUME && !h->started) {
        if (v->start(asio) == ASE_OK) h->started = 1;
      } else if (msg.message == WM_ASIO_OUTPUT_READY) {
        v->outputReady(asio);
      } else {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
      }
    }
    if (h->quit) break;
    if (h->start_requested && !h->started) {
      h->start_requested = 0;
      if (v->start(asio) == ASE_OK) h->started = 1;
    }
    if (h->stop_requested && h->started) {
      h->stop_requested = 0;
      v->stop(asio);
      h->started = 0;
    }
    WaitMessage();
  }
  if (h->started) v->stop(asio);
  v->disposeBuffers(asio);
  v->Release(asio);
  h->asio = NULL;
  h->v = NULL;
  CoUninitialize();
  return 0;
}

static int asio_open(const NaoeConfig *cfg, NaoeFormat *actual, int *buffer_frames, void **out, char *err,
                     size_t err_len, char *supported, size_t supported_len) {
  (void)supported;
  (void)supported_len;
  wchar_t clsid_str[128] = {0};
  char name[256] = {0};
  if (strncmp(cfg->device, "asio:", 5) == 0) {
    if (MultiByteToWideChar(CP_UTF8, 0, cfg->device + 5, -1, clsid_str, 127) <= 0) {
      snprintf(err, err_len, "ASIO 设备 ID 无效");
      return -1;
    }
    wide_to_utf8(clsid_str, name, sizeof(name));
  } else if (!find_asio_driver(clsid_str, 128, name, sizeof(name))) {
    snprintf(err, err_len, "找不到已注册的 ASIO 驱动");
    return -1;
  }

  AsioHandle *h = (AsioHandle *)calloc(1, sizeof(AsioHandle));
  if (!h) {
    snprintf(err, err_len, "内存不足");
    return -1;
  }
  h->channels = 2;
  h->gain = 1.0;
  h->rate = cfg->sample_rate;
  h->buffer_ms = cfg->buffer_ms;
  wcsncpy(h->clsid, clsid_str, 127);
  InitializeCriticalSection(&h->lock);
  h->ring = (int32_t *)calloc(ASIO_RING_SAMPLES, sizeof(int32_t));
  h->ready_event = CreateEventW(NULL, FALSE, FALSE, NULL);
  if (!h->ring || !h->ready_event) {
    snprintf(err, err_len, "ASIO 缓冲分配失败");
    if (h->ring) free(h->ring);
    if (h->ready_event) CloseHandle(h->ready_event);
    DeleteCriticalSection(&h->lock);
    free(h);
    return -1;
  }
  g_asio = h;
  h->thread = CreateThread(NULL, 0, asio_thread_main, h, 0, &h->thread_id);
  if (!h->thread) {
    snprintf(err, err_len, "无法创建 ASIO 线程");
    g_asio = NULL;
    free(h->ring);
    CloseHandle(h->ready_event);
    DeleteCriticalSection(&h->lock);
    free(h);
    return -1;
  }
  WaitForSingleObject(h->ready_event, 8000);
  if (!h->open_ok) {
    snprintf(err, err_len, "%s", h->errbuf[0] ? h->errbuf : "ASIO 初始化失败");
    h->quit = 1;
    PostThreadMessageW(h->thread_id, WM_QUIT, 0, 0);
    WaitForSingleObject(h->thread, 3000);
    CloseHandle(h->thread);
    CloseHandle(h->ready_event);
    g_asio = NULL;
    free(h->ring);
    DeleteCriticalSection(&h->lock);
    free(h);
    return -1;
  }
  actual->sample_rate = cfg->sample_rate;
  actual->channels = 2;
  actual->bits = 32;
  snprintf(actual->sample_format, sizeof(actual->sample_format), "s32le");
  *buffer_frames = (int)h->buffer_frames;
  *out = h;
  return 0;
}

static int asio_request_start(AsioHandle *h) {
  if (h->started) return 0;
  for (int attempt = 0; attempt < 4 && !h->started; attempt++) {
    if (InterlockedCompareExchange(&h->start_requested, 1, 0) == 0) {
      PostThreadMessageW(h->thread_id, WM_ASIO_START, 0, 0);
    }
    for (int i = 0; i < 500 && !h->started; i++) naoe_sleep_ms(1);
  }
  return h->started ? 0 : -1;
}

static int asio_write(void *opaque, const float *input, int frames) {
  AsioHandle *h = (AsioHandle *)opaque;
  if (!h) return -1;
  if (asio_request_start(h) < 0) return -1;
  int channels = h->channels;
  double gain = h->gain;
  int written = 0;
  while (written < frames) {
    EnterCriticalSection(&h->lock);
    size_t space = ASIO_RING_SAMPLES - h->count;
    int take = frames - written;
    if ((size_t)take > space / (size_t)channels) take = (int)(space / (size_t)channels);
    for (int i = 0; i < take * channels; i++) {
      double value = (double)input[(size_t)written * channels + i] * gain;
      if (value > 1.0) value = 1.0;
      if (value < -1.0) value = -1.0;
      h->ring[h->tail] = (int32_t)llround(value * 2147483647.0);
      h->tail = (h->tail + 1) % ASIO_RING_SAMPLES;
      h->count++;
    }
    LeaveCriticalSection(&h->lock);
    written += take;
    if (take == 0) naoe_sleep_ms(1);
  }
  return frames;
}

static int asio_write_int(void *opaque, const void *input, int frames, int bits) {
  AsioHandle *h = (AsioHandle *)opaque;
  if (!h) return -1;
  if (asio_request_start(h) < 0) return -1;
  int channels = h->channels;
  const unsigned char *src = (const unsigned char *)input;
  int written = 0;
  int bps = bits == 16 ? 2 : 4;
  while (written < frames) {
    EnterCriticalSection(&h->lock);
    size_t space = ASIO_RING_SAMPLES - h->count;
    int take = frames - written;
    if ((size_t)take > space / (size_t)channels) take = (int)(space / (size_t)channels);
    for (int i = 0; i < take * channels; i++) {
      int32_t value = 0;
      if (bits == 16) {
        int16_t sample;
        memcpy(&sample, src + ((size_t)written * channels + i) * bps, sizeof(sample));
        value = (int32_t)sample << 16;
      } else {
        memcpy(&value, src + ((size_t)written * channels + i) * bps, sizeof(value));
      }
      h->ring[h->tail] = value;
      h->tail = (h->tail + 1) % ASIO_RING_SAMPLES;
      h->count++;
    }
    LeaveCriticalSection(&h->lock);
    written += take;
    if (take == 0) naoe_sleep_ms(1);
  }
  return frames;
}

static int asio_position(void *opaque, uint64_t *played) {
  AsioHandle *h = (AsioHandle *)opaque;
  if (!h) return -1;
  EnterCriticalSection(&h->lock);
  *played = h->written;
  LeaveCriticalSection(&h->lock);
  return 0;
}

static void asio_pause(void *opaque, int paused) {
  AsioHandle *h = (AsioHandle *)opaque;
  if (!h) return;
  h->paused = paused ? 1 : 0;
  if (paused) {
    EnterCriticalSection(&h->lock);
    h->head = h->tail = h->count = 0;
    LeaveCriticalSection(&h->lock);
  }
}

static void asio_volume(void *opaque, double gain) {
  AsioHandle *h = (AsioHandle *)opaque;
  if (h) h->gain = gain <= 0 ? 1.0 : gain;
}

static void asio_flush(void *opaque) {
  AsioHandle *h = (AsioHandle *)opaque;
  if (!h) return;
  EnterCriticalSection(&h->lock);
  h->head = h->tail = h->count = 0;
  LeaveCriticalSection(&h->lock);
}

static int asio_drain(void *opaque) {
  AsioHandle *h = (AsioHandle *)opaque;
  if (!h) return 0;
  for (int i = 0; i < 5000; i++) {
    EnterCriticalSection(&h->lock);
    size_t count = h->count;
    LeaveCriticalSection(&h->lock);
    if (count == 0) break;
    naoe_sleep_ms(2);
  }
  return 0;
}

static void asio_close(void *opaque) {
  AsioHandle *h = (AsioHandle *)opaque;
  if (!h) return;
  if (g_asio == h) g_asio = NULL;
  h->quit = 1;
  if (h->thread_id) PostThreadMessageW(h->thread_id, WM_QUIT, 0, 0);
  if (h->thread) {
    WaitForSingleObject(h->thread, 3000);
    CloseHandle(h->thread);
  }
  if (h->ready_event) CloseHandle(h->ready_event);
  if (h->ring) free(h->ring);
  DeleteCriticalSection(&h->lock);
  free(h);
}

const NaoeBackend naoe_asio_backend = {
    .name = "asio",
    .open = asio_open,
    .write = asio_write,
    .write_int = asio_write_int,
    .position = asio_position,
    .pause = asio_pause,
    .volume = asio_volume,
    .flush = asio_flush,
    .drain = asio_drain,
    .close = asio_close,
    .probe = asio_probe,
};

#else /* !_WIN32 */

static int asio_open(const NaoeConfig *cfg, NaoeFormat *actual, int *buffer_frames, void **out, char *err,
                     size_t err_len, char *supported, size_t supported_len) {
  (void)cfg;
  (void)actual;
  (void)buffer_frames;
  (void)out;
  (void)supported;
  (void)supported_len;
  snprintf(err, err_len, "此二进制不包含 ASIO 后端");
  return -1;
}

const NaoeBackend naoe_asio_backend = {
    .name = "asio",
    .open = asio_open,
    .write = NULL,
    .write_int = NULL,
    .position = NULL,
    .pause = NULL,
    .volume = NULL,
    .flush = NULL,
    .drain = NULL,
    .close = NULL,
    .probe = NULL,
};

#endif
