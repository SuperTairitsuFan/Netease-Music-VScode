/*
 * WASAPI backend (Windows).
 *
 * Exclusive mode negotiates the exact PCM format with the endpoint and never
 * silently falls back. Shared mode uses WASAPI's own sample-rate conversion
 * (AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM), which is by definition not bit-perfect.
 */
#include "naoe.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)

#define INITGUID
#define COBJMACROS
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <avrt.h>
#include <functiondiscoverykeys_devpkey.h>
#include <ksmedia.h>
#include <propsys.h>

typedef struct {
  IMMDevice *device;
  IAudioClient *client;
  IAudioRenderClient *render;
  WAVEFORMATEXTENSIBLE format;
  int buffer_frames;
  int channels;
  int bits;
  int sample_rate;
  int exclusive;
  int started;
  int mmcss_set;
  HANDLE event;
  HANDLE mmcss;
  volatile double volume;
  uint64_t written;
  unsigned char *convert;
  size_t convert_capacity;
} WasapiHandle;

static void wide_to_utf8(const wchar_t *input, char *output, size_t output_len) {
  if (!input) {
    output[0] = '\0';
    return;
  }
  int n = WideCharToMultiByte(CP_UTF8, 0, input, -1, output, (int)output_len - 1, NULL, NULL);
  if (n <= 0) output[0] = '\0';
  else output[output_len - 1] = '\0';
}

static int bytes_per_sample(int bits) { return bits == 16 ? 2 : 4; }

static void fill_format(WAVEFORMATEXTENSIBLE *wfx, int rate, int channels, int bits) {
  memset(wfx, 0, sizeof(*wfx));
  wfx->Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
  wfx->Format.nChannels = (WORD)channels;
  wfx->Format.nSamplesPerSec = (DWORD)rate;
  wfx->Format.wBitsPerSample = (WORD)(bits == 24 ? 32 : bits);
  wfx->Format.nBlockAlign = (WORD)(channels * (wfx->Format.wBitsPerSample / 8));
  wfx->Format.nAvgBytesPerSec = wfx->Format.nSamplesPerSec * wfx->Format.nBlockAlign;
  wfx->Format.cbSize = sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX);
  wfx->Samples.wValidBitsPerSample = (WORD)bits;
  wfx->dwChannelMask = channels == 1 ? SPEAKER_FRONT_CENTER
                                     : channels == 2 ? (SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT)
                                                     : 0;
  wfx->SubFormat = KSDATAFORMAT_SUBTYPE_PCM;
}

static IMMDevice *find_device(IMMDeviceEnumerator *enumerator, const char *id, int *is_default) {
  if (is_default) *is_default = 0;
  if (!id || !*id || strcmp(id, "default") == 0) {
    IMMDevice *device = NULL;
    if (SUCCEEDED(IMMDeviceEnumerator_GetDefaultAudioEndpoint(enumerator, eRender, eConsole, &device))) {
      if (is_default) *is_default = 1;
      return device;
    }
    return NULL;
  }
  wchar_t wide[512];
  if (MultiByteToWideChar(CP_UTF8, 0, id, -1, wide, 511) <= 0) return NULL;
  IMMDevice *device = NULL;
  if (FAILED(IMMDeviceEnumerator_GetDevice(enumerator, wide, &device))) return NULL;
  return device;
}

static int device_formats_json(IMMDevice *device, char *out, size_t out_len, int *count_out) {
  static const int rates[] = {44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000};
  static const int bits_list[] = {16, 24, 32};
  IAudioClient *client = NULL;
  if (FAILED(IMMDevice_Activate(device, &IID_IAudioClient, CLSCTX_ALL, NULL, (void **)&client))) {
    if (count_out) *count_out = 0;
    return -1;
  }
  WAVEFORMATEX *mix = NULL;
  int have_mix = SUCCEEDED(IAudioClient_GetMixFormat(client, &mix)) && mix;
  size_t used = 0;
  int count = 0;
  for (size_t r = 0; r < sizeof(rates) / sizeof(rates[0]); r++) {
    for (size_t b = 0; b < sizeof(bits_list) / sizeof(bits_list[0]); b++) {
      WAVEFORMATEXTENSIBLE wfx;
      fill_format(&wfx, rates[r], 2, bits_list[b]);
      WAVEFORMATEX *closest = NULL;
      HRESULT hr = IAudioClient_IsFormatSupported(client, AUDCLNT_SHAREMODE_EXCLUSIVE, &wfx.Format, &closest);
      if (closest) CoTaskMemFree(closest);
      if (hr != S_OK) continue;
      if (count > 0) used += (size_t)snprintf(out + used, out_len - used, ",");
      used += (size_t)snprintf(out + used, out_len - used,
                               "{\"sampleRate\":%d,\"bits\":%d,\"channels\":2,\"sampleFormat\":\"%s\"}",
                               rates[r], bits_list[b],
                               bits_list[b] == 16 ? "s16le" : bits_list[b] == 24 ? "s24le" : "s32le");
      count++;
      if (used + 256 > out_len) break;
    }
  }
  if (have_mix && count < 24) {
    int mix_bits = mix->wBitsPerSample;
    if (mix_bits == 32) mix_bits = 32;
    if (count > 0) used += (size_t)snprintf(out + used, out_len - used, ",");
    used += (size_t)snprintf(out + used, out_len - used,
                             "{\"sampleRate\":%d,\"bits\":%d,\"channels\":%d,\"sampleFormat\":\"%s\"}",
                             (int)mix->nSamplesPerSec, mix_bits, (int)mix->nChannels,
                             mix->wBitsPerSample == 32 ? "s32le" : "s16le");
    count++;
  }
  if (mix) CoTaskMemFree(mix);
  IAudioClient_Release(client);
  if (count_out) *count_out = count;
  return 0;
}

static int wasapi_probe(const NaoeBackend *backend, char *json, size_t json_len) {
  (void)backend;
  HRESULT hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
  int uninit = SUCCEEDED(hr);
  if (hr == RPC_E_CHANGED_MODE) uninit = 0;
  IMMDeviceEnumerator *enumerator = NULL;
  if (FAILED(CoCreateInstance(&CLSID_MMDeviceEnumerator, NULL, CLSCTX_ALL, &IID_IMMDeviceEnumerator,
                              (void **)&enumerator))) {
    snprintf(json, json_len, "[]");
    if (uninit) CoUninitialize();
    return 0;
  }
  IMMDeviceCollection *collection = NULL;
  if (FAILED(IMMDeviceEnumerator_EnumAudioEndpoints(enumerator, eRender, DEVICE_STATE_ACTIVE, &collection))) {
    snprintf(json, json_len, "[]");
    IMMDeviceEnumerator_Release(enumerator);
    if (uninit) CoUninitialize();
    return 0;
  }

  LPWSTR default_id = NULL;
  IMMDevice *defaults = NULL;
  if (SUCCEEDED(IMMDeviceEnumerator_GetDefaultAudioEndpoint(enumerator, eRender, eConsole, &defaults))) {
    IMMDevice_GetId(defaults, &default_id);
  }

  UINT count = 0;
  IMMDeviceCollection_GetCount(collection, &count);
  size_t used = 0;
  int emitted = 0;
  used += (size_t)snprintf(json + used, json_len - used, "[");
  for (UINT i = 0; i < count && emitted < 16; i++) {
    IMMDevice *device = NULL;
    if (FAILED(IMMDeviceCollection_Item(collection, i, &device))) continue;
    LPWSTR id = NULL;
    IMMDevice_GetId(device, &id);
    int is_default = id && default_id && wcscmp(id, default_id) == 0;
    IPropertyStore *store = NULL;
    char name[512] = {0};
    if (SUCCEEDED(IMMDevice_OpenPropertyStore(device, STGM_READ, &store))) {
      PROPVARIANT value;
      PropVariantInit(&value);
      if (SUCCEEDED(IPropertyStore_GetValue(store, &PKEY_Device_FriendlyName, &value)) &&
          value.vt == VT_LPWSTR) {
        wide_to_utf8(value.pwszVal, name, sizeof(name));
      }
      PropVariantClear(&value);
      IPropertyStore_Release(store);
    }
    if (!name[0]) snprintf(name, sizeof(name), "音频设备 %u", i + 1);
    char id_utf8[512] = {0};
    wide_to_utf8(id, id_utf8, sizeof(id_utf8));
    char formats[4096];
    int format_count = 0;
    device_formats_json(device, formats, sizeof(formats), &format_count);
    if (format_count > 0) {
      char esc_name[768];
      char esc_id[768];
      naoe_json_escape(name, esc_name, sizeof(esc_name));
      naoe_json_escape(id_utf8, esc_id, sizeof(esc_id));
      if (emitted > 0) used += (size_t)snprintf(json + used, json_len - used, ",");
      used += (size_t)snprintf(json + used, json_len - used,
                               "{\"id\":\"%s\",\"name\":\"%s\",\"backend\":\"wasapi\",\"isDefault\":%s,"
                               "\"formats\":[%s]}",
                               esc_id, esc_name, is_default ? "true" : "false", formats);
      emitted++;
    }
    if (id) CoTaskMemFree(id);
    IMMDevice_Release(device);
    if (used + 2048 > json_len) break;
  }
  used += (size_t)snprintf(json + used, json_len - used, "]");
  if (default_id) CoTaskMemFree(default_id);
  if (defaults) IMMDevice_Release(defaults);
  IMMDeviceCollection_Release(collection);
  IMMDeviceEnumerator_Release(enumerator);
  if (uninit) CoUninitialize();
  return emitted;
}

static int wasapi_open(const NaoeConfig *cfg, NaoeFormat *actual, int *buffer_frames, void **out, char *err,
                       size_t err_len, char *supported, size_t supported_len) {
  HRESULT hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
  int uninit = SUCCEEDED(hr);
  if (hr == RPC_E_CHANGED_MODE) uninit = 0;
  IMMDeviceEnumerator *enumerator = NULL;
  IMMDevice *device = NULL;
  IAudioClient *client = NULL;
  WasapiHandle *handle = NULL;
  int is_default = 0;

  if (FAILED(CoCreateInstance(&CLSID_MMDeviceEnumerator, NULL, CLSCTX_ALL, &IID_IMMDeviceEnumerator,
                              (void **)&enumerator))) {
    snprintf(err, err_len, "无法创建 WASAPI 设备枚举器");
    goto fail;
  }
  device = find_device(enumerator, cfg->device, &is_default);
  if (!device) {
    snprintf(err, err_len, "找不到音频设备：%s", cfg->device);
    goto fail;
  }
  if (FAILED(IMMDevice_Activate(device, &IID_IAudioClient, CLSCTX_ALL, NULL, (void **)&client))) {
    snprintf(err, err_len, "无法激活音频客户端");
    goto fail;
  }

  WAVEFORMATEXTENSIBLE wfx;
  fill_format(&wfx, cfg->sample_rate, cfg->channels, cfg->bits);
  WAVEFORMATEX *closest = NULL;
  if (cfg->exclusive) {
    hr = IAudioClient_IsFormatSupported(client, AUDCLNT_SHAREMODE_EXCLUSIVE, &wfx.Format, &closest);
    if (closest) {
      CoTaskMemFree(closest);
      closest = NULL;
    }
    if (hr != S_OK) {
      snprintf(err, err_len,
               "设备不支持独占 %d Hz / %d bit / %d 声道（不做静默降级）", cfg->sample_rate, cfg->bits,
               cfg->channels);
      device_formats_json(device, supported, supported_len, NULL);
      goto fail;
    }
  }

  DWORD flags = cfg->exclusive
                     ? AUDCLNT_STREAMFLAGS_EVENTCALLBACK
                     : (AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY);
  REFERENCE_TIME duration = (REFERENCE_TIME)(cfg->buffer_ms > 0 ? cfg->buffer_ms : 10) * 10000;
  hr = IAudioClient_Initialize(client, cfg->exclusive ? AUDCLNT_SHAREMODE_EXCLUSIVE : AUDCLNT_SHAREMODE_SHARED,
                               flags, duration, cfg->exclusive ? duration : 0, &wfx.Format, NULL);
  if (FAILED(hr)) {
    snprintf(err, err_len, "初始化 WASAPI 失败（0x%08lx）%s", (unsigned long)hr,
             cfg->exclusive ? "，设备可能被其他独占程序占用" : "");
    device_formats_json(device, supported, supported_len, NULL);
    goto fail;
  }

  UINT32 buffer = 0;
  IAudioClient_GetBufferSize(client, &buffer);
  handle = (WasapiHandle *)calloc(1, sizeof(WasapiHandle));
  if (!handle) { snprintf(err, err_len, "内存不足"); goto fail; }
  if (cfg->exclusive) {
    handle->event = CreateEventW(NULL, FALSE, FALSE, NULL);
    if (!handle->event || FAILED(IAudioClient_SetEventHandle(client, handle->event))) {
      snprintf(err, err_len, "无法创建 WASAPI 事件");
      goto fail;
    }
  }
  handle->device = device;
  handle->client = client;
  if (FAILED(IAudioClient_GetService(client, &IID_IAudioRenderClient, (void **)&handle->render))) {
    snprintf(err, err_len, "无法获取 WASAPI 渲染客户端");
    goto fail;
  }
  handle->format = wfx;
  handle->buffer_frames = (int)buffer;
  handle->channels = cfg->channels;
  handle->bits = cfg->bits;
  handle->sample_rate = cfg->sample_rate;
  handle->exclusive = cfg->exclusive;
  handle->volume = cfg->volume <= 0 ? 1.0 : cfg->volume;
  handle->convert_capacity = (size_t)buffer * (size_t)cfg->channels * 4u + 4096u;
  handle->convert = (unsigned char *)malloc(handle->convert_capacity);
  if (!handle->convert) {
    snprintf(err, err_len, "内存不足");
    goto fail;
  }

  actual->sample_rate = cfg->sample_rate;
  actual->channels = cfg->channels;
  actual->bits = cfg->bits;
  snprintf(actual->sample_format, sizeof(actual->sample_format), "%s",
           cfg->bits == 16 ? "s16le" : cfg->bits == 24 ? "s24le" : "s32le");
  *buffer_frames = (int)buffer;
  *out = handle;
  (void)is_default;
  if (uninit) {
    /* COM stays initialized on this thread for the lifetime of the session. */
  }
  return 0;

fail:
  if (client) IAudioClient_Release(client);
  if (device) IMMDevice_Release(device);
  if (enumerator) IMMDeviceEnumerator_Release(enumerator);
  if (uninit) CoUninitialize();
  return -1;
}

static int wasapi_write(void *opaque, const float *input, int frames) {
  WasapiHandle *handle = (WasapiHandle *)opaque;
  if (!handle || frames <= 0) return 0;
  if (!handle->started) {
    if (FAILED(IAudioClient_Start(handle->client))) return -1;
    handle->started = 1;
  }
  int channels = handle->channels;
  int bps = bytes_per_sample(handle->bits);
  size_t samples = (size_t)frames * (size_t)channels;
  double gain = handle->volume;
  unsigned char *out = handle->convert;
  if (handle->bits == 16) {
    int16_t *dst = (int16_t *)out;
    for (size_t i = 0; i < samples; i++) {
      double v = input[i] * gain;
      if (v > 1.0) v = 1.0;
      if (v < -1.0) v = -1.0;
      dst[i] = (int16_t)llround(v * 32767.0);
    }
  } else if (handle->bits == 24) {
    int32_t *dst = (int32_t *)out;
    for (size_t i = 0; i < samples; i++) {
      double v = input[i] * gain;
      if (v > 1.0) v = 1.0;
      if (v < -1.0) v = -1.0;
      dst[i] = (int32_t)llround(v * 8388607.0) << 8;
    }
  } else {
    int32_t *dst = (int32_t *)out;
    for (size_t i = 0; i < samples; i++) {
      double v = input[i] * gain;
      if (v > 1.0) v = 1.0;
      if (v < -1.0) v = -1.0;
      dst[i] = (int32_t)llround(v * 2147483647.0);
    }
  }

  int written = 0;
  while (written < frames) {
    UINT32 padding = 0;
    if (FAILED(IAudioClient_GetCurrentPadding(handle->client, &padding))) return -1;
    UINT32 free_frames = (UINT32)handle->buffer_frames - padding;
    if (free_frames == 0) {
      if (handle->event) WaitForSingleObject(handle->event, 5); else naoe_sleep_ms(1);
      continue;
    }
    UINT32 want = (UINT32)(frames - written);
    if (want > free_frames) want = free_frames;
    BYTE *buffer = NULL;
    if (FAILED(IAudioRenderClient_GetBuffer(handle->render, want, &buffer))) return -1;
    memcpy(buffer, out + (size_t)written * (size_t)channels * (size_t)bps, (size_t)want * (size_t)bps);
    IAudioRenderClient_ReleaseBuffer(handle->render, want, 0);
    written += (int)want;
    handle->written += want;
  }
  return frames;
}

static int wasapi_write_int(void *opaque, const void *input, int frames, int bits) {
  WasapiHandle *handle = (WasapiHandle *)opaque;
  if (!handle || frames <= 0) return 0;
  if (!handle->started) {
    if (FAILED(IAudioClient_Start(handle->client))) return -1;
    handle->started = 1;
  }
  if (!handle->mmcss_set) {
    DWORD task = 0;
    handle->mmcss = AvSetMmThreadCharacteristicsW(L"Pro Audio", &task);
    if (handle->mmcss) AvSetMmThreadPriority(handle->mmcss, AVRT_PRIORITY_CRITICAL);
    handle->mmcss_set = 1;
  }
  int bps = bits == 16 ? 2 : 4;
  const unsigned char *src = (const unsigned char *)input;
  int written = 0;
  while (written < frames) {
    UINT32 padding = 0;
    if (FAILED(IAudioClient_GetCurrentPadding(handle->client, &padding))) return -1;
    UINT32 free_frames = (UINT32)handle->buffer_frames - padding;
    if (free_frames == 0) {
      naoe_sleep_ms(1);
      continue;
    }
    UINT32 want = (UINT32)(frames - written);
    if (want > free_frames) want = free_frames;
    BYTE *buffer = NULL;
    if (FAILED(IAudioRenderClient_GetBuffer(handle->render, want, &buffer))) return -1;
    memcpy(buffer, src + (size_t)written * (size_t)handle->channels * (size_t)bps,
           (size_t)want * (size_t)handle->channels * (size_t)bps);
    IAudioRenderClient_ReleaseBuffer(handle->render, want, 0);
    written += (int)want;
    handle->written += want;
  }
  return frames;
}

static int wasapi_position(void *opaque, uint64_t *played) {
  WasapiHandle *handle = (WasapiHandle *)opaque;
  if (!handle) return -1;
  UINT32 padding = 0;
  if (SUCCEEDED(IAudioClient_GetCurrentPadding(handle->client, &padding)) &&
      handle->written >= (uint64_t)padding) {
    *played = handle->written - (uint64_t)padding;
  } else {
    *played = handle->written;
  }
  return 0;
}

static void wasapi_pause(void *opaque, int paused) {
  WasapiHandle *handle = (WasapiHandle *)opaque;
  if (!handle || !handle->started) return;
  if (paused) {
    IAudioClient_Stop(handle->client);
  } else {
    IAudioClient_Start(handle->client);
  }
}

static void wasapi_volume(void *opaque, double gain) {
  WasapiHandle *handle = (WasapiHandle *)opaque;
  if (handle) handle->volume = gain;
}

static void wasapi_flush(void *opaque) {
  WasapiHandle *handle = (WasapiHandle *)opaque;
  if (!handle || !handle->client) return;
  IAudioClient_Stop(handle->client);
  IAudioClient_Reset(handle->client);
  handle->written = 0;
  handle->started = 0;
}

static int wasapi_drain(void *opaque) {
  WasapiHandle *handle = (WasapiHandle *)opaque;
  if (!handle || !handle->client) return 0;
  for (int i = 0; i < 5000; i++) {
    UINT32 padding = 0;
    if (FAILED(IAudioClient_GetCurrentPadding(handle->client, &padding))) break;
    if (padding == 0) break;
    naoe_sleep_ms(2);
  }
  IAudioClient_Stop(handle->client);
  handle->started = 0;
  return 0;
}

static void wasapi_close(void *opaque) {
  WasapiHandle *handle = (WasapiHandle *)opaque;
  if (!handle) return;
  if (handle->client) {
    IAudioClient_Stop(handle->client);
    IAudioClient_Release(handle->client);
  }
  if (handle->mmcss) AvRevertMmThreadCharacteristics(handle->mmcss);
  if (handle->event) CloseHandle(handle->event);
  if (handle->render) IAudioRenderClient_Release(handle->render);
  if (handle->device) IMMDevice_Release(handle->device);
  free(handle->convert);
  free(handle);
}

const NaoeBackend naoe_wasapi_backend = {
    .name = "wasapi",
    .open = wasapi_open,
    .write = wasapi_write,
    .write_int = wasapi_write_int,
    .position = wasapi_position,
    .pause = wasapi_pause,
    .volume = wasapi_volume,
    .flush = wasapi_flush,
    .drain = wasapi_drain,
    .close = wasapi_close,
    .probe = wasapi_probe,
};

#else /* !_WIN32 */

static int wasapi_open(const NaoeConfig *cfg, NaoeFormat *actual, int *buffer_frames, void **out, char *err,
                       size_t err_len, char *supported, size_t supported_len) {
  (void)cfg;
  (void)actual;
  (void)buffer_frames;
  (void)out;
  (void)supported;
  (void)supported_len;
  snprintf(err, err_len, "此二进制不包含 WASAPI 后端");
  return -1;
}

const NaoeBackend naoe_wasapi_backend = {
    .name = "wasapi",
    .open = wasapi_open,
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
