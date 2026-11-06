/*
 * CoreAudio backend for macOS.
 *
 * The HAL output AudioUnit is driven by a render callback on the realtime
 * audio thread. The engine's pump thread produces PCM into a single-producer
 * single-consumer ring, so the callback never blocks or allocates.
 *
 * Device IDs exposed to the extension are the stable CoreAudio device UIDs.
 * `exclusive` asks CoreAudio for hog mode: the device is taken away from the
 * system mixer and other applications, which is the closest public equivalent
 * to WASAPI Exclusive on macOS. Hog mode is best effort; if the device does
 * not allow it playback continues in shared mode instead of failing.
 */
#include "naoe.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdatomic.h>

#if defined(__APPLE__)

#include <AudioToolbox/AudioToolbox.h>
#include <CoreAudio/CoreAudio.h>
#include <CoreFoundation/CoreFoundation.h>
#include <unistd.h>

#define CA_MAX_CHANNELS 8
#define CA_MAX_DEVICES 64
#define CA_CONVERT_FRAMES 16384

/* ElementMaster is still the portable spelling across supported SDKs. */
#define CA_ELEMENT_MAIN kAudioObjectPropertyElementMaster

typedef struct {
  AudioUnit unit;
  AudioDeviceID device_id;
  int sample_rate;
  int channels;
  int bits;
  int is_float;
  int is_s16;
  int is_s32;
  size_t frame_bytes;
  size_t capacity_frames;
  uint8_t *ring;
  _Atomic size_t write_pos;
  _Atomic size_t read_pos;
  _Atomic uint64_t rendered_frames;
  _Atomic double volume;
  _Atomic int stopping;
  uint8_t *convert;
  pid_t hog_pid;
  int hogged;
  Float64 original_rate;
  int nominal_changed;
} CoreAudioHandle;

/* ------------------------------------------------------------------ helpers */

static int ca_copy_string(AudioObjectID object, AudioObjectPropertySelector selector, char *out, size_t out_len) {
  if (out_len == 0) return -1;
  out[0] = '\0';
  AudioObjectPropertyAddress addr = {selector, kAudioObjectPropertyScopeGlobal, CA_ELEMENT_MAIN};
  CFStringRef value = NULL;
  UInt32 size = (UInt32)sizeof(value);
  if (AudioObjectGetPropertyData(object, &addr, 0, NULL, &size, &value) != noErr || !value) return -1;
  Boolean ok = CFStringGetCString(value, out, (CFIndex)out_len, kCFStringEncodingUTF8);
  CFRelease(value);
  if (!ok) out[0] = '\0';
  return ok ? 0 : -1;
}

static AudioDeviceID ca_default_output(void) {
  AudioDeviceID device = kAudioObjectUnknown;
  AudioObjectPropertyAddress addr = {kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectPropertyScopeGlobal,
                                     CA_ELEMENT_MAIN};
  UInt32 size = (UInt32)sizeof(device);
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &addr, 0, NULL, &size, &device) != noErr) {
    return kAudioObjectUnknown;
  }
  return device;
}

static int ca_output_channels(AudioDeviceID device) {
  AudioObjectPropertyAddress addr = {kAudioDevicePropertyStreamConfiguration, kAudioDevicePropertyScopeOutput,
                                     CA_ELEMENT_MAIN};
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(device, &addr, 0, NULL, &size) != noErr || size == 0) return 0;
  AudioBufferList *list = (AudioBufferList *)malloc(size);
  if (!list) return 0;
  int channels = 0;
  if (AudioObjectGetPropertyData(device, &addr, 0, NULL, &size, list) == noErr) {
    for (UInt32 i = 0; i < list->mNumberBuffers; i++) channels += (int)list->mBuffers[i].mNumberChannels;
  }
  free(list);
  return channels;
}

static int ca_device_supports_output(AudioDeviceID device) { return ca_output_channels(device) > 0; }

/* Returns 1 when the device has an output scope and is not an aggregate. */
static int ca_list_devices(AudioDeviceID *out, int max) {
  AudioObjectPropertyAddress addr = {kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal,
                                     CA_ELEMENT_MAIN};
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &addr, 0, NULL, &size) != noErr) return 0;
  int count = (int)(size / sizeof(AudioDeviceID));
  if (count <= 0) return 0;
  AudioDeviceID *all = (AudioDeviceID *)malloc(size);
  if (!all) return 0;
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &addr, 0, NULL, &size, all) != noErr) {
    free(all);
    return 0;
  }
  int emitted = 0;
  for (int i = 0; i < count && emitted < max; i++) {
    if (!ca_device_supports_output(all[i])) continue;
    out[emitted++] = all[i];
  }
  free(all);
  return emitted;
}

static AudioDeviceID ca_find_device(const char *name, char *err, size_t err_len) {
  if (!name || !*name || strcmp(name, "default") == 0) {
    AudioDeviceID device = ca_default_output();
    if (device == kAudioObjectUnknown) {
      snprintf(err, err_len, "系统没有可用的默认输出设备");
      return kAudioObjectUnknown;
    }
    return device;
  }
  AudioDeviceID devices[CA_MAX_DEVICES];
  int count = ca_list_devices(devices, CA_MAX_DEVICES);
  for (int i = 0; i < count; i++) {
    char uid[512];
    if (ca_copy_string(devices[i], kAudioDevicePropertyDeviceUID, uid, sizeof(uid)) == 0 && strcmp(uid, name) == 0) {
      return devices[i];
    }
  }
  /* Accept a raw CoreAudio device number as a fallback (handy for scripts). */
  char *end = NULL;
  long numeric = strtol(name, &end, 10);
  if (end && *end == '\0' && numeric > 0) {
    for (int i = 0; i < count; i++) {
      if ((long)devices[i] == numeric) return devices[i];
    }
  }
  snprintf(err, err_len, "找不到 CoreAudio 输出设备：%s", name);
  return kAudioObjectUnknown;
}

static void ca_restore_nominal_rate(CoreAudioHandle *handle) {
  if (!handle || !handle->nominal_changed) return;
  Float64 rate = handle->original_rate;
  AudioObjectPropertyAddress addr = {kAudioDevicePropertyNominalSampleRate, kAudioObjectPropertyScopeGlobal,
                                     CA_ELEMENT_MAIN};
  AudioObjectSetPropertyData(handle->device_id, &addr, 0, NULL, (UInt32)sizeof(rate), &rate);
  handle->nominal_changed = 0;
}

static OSStatus ca_hog(AudioDeviceID device, pid_t pid) {
  AudioObjectPropertyAddress addr = {kAudioDevicePropertyHogMode, kAudioObjectPropertyScopeGlobal, CA_ELEMENT_MAIN};
  pid_t value = pid;
  return AudioObjectSetPropertyData(device, &addr, 0, NULL, (UInt32)sizeof(value), &value);
}

static void ca_fill_asbd(const NaoeConfig *cfg, AudioStreamBasicDescription *asbd, int *bits, int *is_float) {
  const int wants_float = cfg->sample_format[0] && strcmp(cfg->sample_format, "f32le") == 0;
  const int wants_s16 = cfg->sample_format[0] && strcmp(cfg->sample_format, "s16le") == 0;
  int resolved_bits = cfg->bits;
  if (wants_float) {
    resolved_bits = 32;
  } else if (wants_s16) {
    resolved_bits = 16;
  } else if (resolved_bits == 24) {
    /* 24-bit integer PCM reaches NAOE in 4-byte containers, high aligned. */
    resolved_bits = 32;
  } else if (resolved_bits != 16) {
    resolved_bits = 32;
  }
  memset(asbd, 0, sizeof(*asbd));
  asbd->mSampleRate = (Float64)cfg->sample_rate;
  asbd->mFormatID = kAudioFormatLinearPCM;
  asbd->mFormatFlags = wants_float ? (kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked)
                                   : (kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked);
  asbd->mBitsPerChannel = (UInt32)resolved_bits;
  asbd->mChannelsPerFrame = (UInt32)cfg->channels;
  asbd->mFramesPerPacket = 1;
  asbd->mBytesPerFrame = (UInt32)((resolved_bits / 8) * cfg->channels);
  asbd->mBytesPerPacket = asbd->mBytesPerFrame;
  *bits = resolved_bits;
  *is_float = wants_float;
}

/* ------------------------------------------------------------------ render */

static OSStatus ca_render(void *ref, AudioUnitRenderActionFlags *flags, const AudioTimeStamp *timestamp,
                          UInt32 bus, UInt32 frames, AudioBufferList *io_data) {
  (void)flags;
  (void)timestamp;
  (void)bus;
  CoreAudioHandle *handle = (CoreAudioHandle *)ref;
  if (!handle || !io_data || io_data->mNumberBuffers == 0) return noErr;
  uint8_t *out = (uint8_t *)io_data->mBuffers[0].mData;
  if (!out) return noErr;
  size_t want = (size_t)frames;
  size_t read = atomic_load_explicit(&handle->read_pos, memory_order_acquire);
  size_t write = atomic_load_explicit(&handle->write_pos, memory_order_acquire);
  size_t available = write - read;
  size_t take = available < want ? available : want;
  if (take > 0) {
    size_t start = read % handle->capacity_frames;
    size_t first = handle->capacity_frames - start;
    if (first > take) first = take;
    memcpy(out, handle->ring + start * handle->frame_bytes, first * handle->frame_bytes);
    if (take > first) {
      memcpy(out + first * handle->frame_bytes, handle->ring, (take - first) * handle->frame_bytes);
    }
  }
  if (take < want) {
    memset(out + take * handle->frame_bytes, 0, (want - take) * handle->frame_bytes);
  }
  atomic_store_explicit(&handle->read_pos, read + take, memory_order_release);
  atomic_fetch_add_explicit(&handle->rendered_frames, (uint64_t)take, memory_order_relaxed);
  return noErr;
}

/* ------------------------------------------------------------------ ring */

static int ca_push(CoreAudioHandle *handle, const uint8_t *src, size_t frames) {
  while (frames > 0) {
    if (atomic_load_explicit(&handle->stopping, memory_order_acquire)) return -1;
    size_t write = atomic_load_explicit(&handle->write_pos, memory_order_relaxed);
    size_t read = atomic_load_explicit(&handle->read_pos, memory_order_acquire);
    size_t used = write - read;
    if (used >= handle->capacity_frames) {
      usleep(500);
      continue;
    }
    size_t take = handle->capacity_frames - used;
    if (take > frames) take = frames;
    size_t start = write % handle->capacity_frames;
    size_t first = handle->capacity_frames - start;
    if (first > take) first = take;
    memcpy(handle->ring + start * handle->frame_bytes, src, first * handle->frame_bytes);
    if (take > first) {
      memcpy(handle->ring, src + first * handle->frame_bytes, (take - first) * handle->frame_bytes);
    }
    atomic_store_explicit(&handle->write_pos, write + take, memory_order_release);
    src += take * handle->frame_bytes;
    frames -= take;
  }
  return 0;
}

/* ------------------------------------------------------------------ backend */

static int ca_open(const NaoeConfig *cfg, NaoeFormat *actual, int *buffer_frames, void **out, char *err,
                   size_t err_len, char *supported, size_t supported_len) {
  if (supported_len) supported[0] = '\0';
  if (cfg->channels < 1 || cfg->channels > CA_MAX_CHANNELS) {
    snprintf(err, err_len, "CoreAudio 最多支持 %d 声道", CA_MAX_CHANNELS);
    return -1;
  }
  char device_err[256] = {0};
  AudioDeviceID device = ca_find_device(cfg->device, device_err, sizeof(device_err));
  if (device == kAudioObjectUnknown) {
    snprintf(err, err_len, "%s", device_err[0] ? device_err : "无法解析输出设备");
    return -1;
  }
  int device_channels = ca_output_channels(device);
  if (device_channels <= 0) {
    snprintf(err, err_len, "所选设备没有输出通道");
    return -1;
  }
  if (cfg->channels > device_channels) {
    snprintf(err, err_len, "设备只有 %d 个输出声道，无法按 %d 声道打开", device_channels, cfg->channels);
    return -1;
  }

  CoreAudioHandle *handle = (CoreAudioHandle *)calloc(1, sizeof(CoreAudioHandle));
  if (!handle) {
    snprintf(err, err_len, "内存不足");
    return -1;
  }
  handle->device_id = device;
  handle->sample_rate = cfg->sample_rate;
  handle->channels = cfg->channels;
  handle->hog_pid = 0;

  if (cfg->exclusive) {
    if (ca_hog(device, getpid()) == noErr) {
      handle->hogged = 1;
      handle->hog_pid = getpid();
    }
  }

  AudioStreamBasicDescription asbd;
  ca_fill_asbd(cfg, &asbd, &handle->bits, &handle->is_float);
  handle->is_s16 = !handle->is_float && handle->bits == 16;
  handle->is_s32 = !handle->is_float && handle->bits == 32;
  handle->frame_bytes = (size_t)asbd.mBytesPerFrame;
  if (handle->frame_bytes == 0) {
    snprintf(err, err_len, "无效的音频格式");
    free(handle);
    return -1;
  }

  /* Two seconds of ring keeps the producer comfortably ahead of the HAL. */
  size_t capacity = (size_t)cfg->sample_rate * 2u;
  if (capacity < 65536u) capacity = 65536u;
  handle->capacity_frames = capacity;
  handle->ring = (uint8_t *)calloc(capacity, handle->frame_bytes);
  handle->convert = (uint8_t *)malloc((size_t)CA_CONVERT_FRAMES * handle->frame_bytes);
  if (!handle->ring || !handle->convert) {
    snprintf(err, err_len, "内存不足");
    free(handle->ring);
    free(handle->convert);
    free(handle);
    return -1;
  }
  atomic_init(&handle->write_pos, 0);
  atomic_init(&handle->read_pos, 0);
  atomic_init(&handle->rendered_frames, 0);
  atomic_init(&handle->volume, cfg->volume <= 0 ? 1.0 : cfg->volume);
  atomic_init(&handle->stopping, 0);

  AudioComponentDescription desc;
  memset(&desc, 0, sizeof(desc));
  desc.componentType = kAudioUnitType_Output;
  desc.componentSubType = kAudioUnitSubType_HALOutput;
  desc.componentManufacturer = kAudioUnitManufacturer_Apple;
  AudioComponent component = AudioComponentFindNext(NULL, &desc);
  if (!component) {
    snprintf(err, err_len, "系统没有可用的 CoreAudio HAL 输出组件");
    goto fail;
  }
  OSStatus status = AudioComponentInstanceNew(component, &handle->unit);
  if (status != noErr) {
    snprintf(err, err_len, "创建 CoreAudio 输出单元失败（%d）", (int)status);
    goto fail;
  }
  status = AudioUnitSetProperty(handle->unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0,
                                &device, (UInt32)sizeof(device));
  if (status != noErr) {
    snprintf(err, err_len, "CoreAudio 无法选择设备（%d）", (int)status);
    goto fail;
  }
  status = AudioUnitSetProperty(handle->unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 0, &asbd,
                                (UInt32)sizeof(asbd));
  if (status != noErr && cfg->exclusive) {
    /* Exclusive playback commonly needs the device nominal rate to match. */
    Float64 rate = (Float64)cfg->sample_rate;
    AudioObjectPropertyAddress rate_addr = {kAudioDevicePropertyNominalSampleRate, kAudioObjectPropertyScopeGlobal,
                                            CA_ELEMENT_MAIN};
    Float64 previous = 0;
    UInt32 previous_size = (UInt32)sizeof(previous);
    if (AudioObjectGetPropertyData(device, &rate_addr, 0, NULL, &previous_size, &previous) == noErr) {
      handle->original_rate = previous;
    }
    if (AudioObjectSetPropertyData(device, &rate_addr, 0, NULL, (UInt32)sizeof(rate), &rate) == noErr) {
      handle->nominal_changed = 1;
    }
    status = AudioUnitSetProperty(handle->unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 0, &asbd,
                                  (UInt32)sizeof(asbd));
  }
  if (status != noErr) {
    snprintf(err, err_len, "设备不支持 %d Hz / %d bit / %d 声道（CoreAudio %d）", cfg->sample_rate, handle->bits,
             cfg->channels, (int)status);
    goto fail;
  }
  UInt32 max_frames = 4096;
  AudioUnitSetProperty(handle->unit, kAudioUnitProperty_MaximumFramesPerSlice, kAudioUnitScope_Global, 0, &max_frames,
                       (UInt32)sizeof(max_frames));
  AURenderCallbackStruct callback;
  memset(&callback, 0, sizeof(callback));
  callback.inputProc = ca_render;
  callback.inputProcRefCon = handle;
  status = AudioUnitSetProperty(handle->unit, kAudioUnitProperty_SetRenderCallback, kAudioUnitScope_Input, 0,
                                &callback, (UInt32)sizeof(callback));
  if (status != noErr) {
    snprintf(err, err_len, "注册 CoreAudio 渲染回调失败（%d）", (int)status);
    goto fail;
  }
  status = AudioUnitInitialize(handle->unit);
  if (status != noErr) {
    snprintf(err, err_len, "初始化 CoreAudio 输出失败（%d）", (int)status);
    goto fail;
  }
  status = AudioOutputUnitStart(handle->unit);
  if (status != noErr) {
    snprintf(err, err_len, "启动 CoreAudio 输出失败（%d）", (int)status);
    AudioUnitUninitialize(handle->unit);
    goto fail;
  }

  actual->sample_rate = handle->sample_rate;
  actual->channels = handle->channels;
  actual->bits = handle->bits;
  snprintf(actual->sample_format, sizeof(actual->sample_format), "%s",
           handle->is_float ? "f32le" : handle->is_s16 ? "s16le" : "s32le");
  int frames = (int)((int64_t)cfg->sample_rate * (cfg->buffer_ms > 0 ? cfg->buffer_ms : 10) / 1000);
  if (frames < 256) frames = 256;
  if (frames > 16384) frames = 16384;
  *buffer_frames = frames;
  *out = handle;
  (void)supported;
  return 0;

fail:
  if (handle->unit) AudioComponentInstanceDispose(handle->unit);
  ca_restore_nominal_rate(handle);
  if (handle->hogged) ca_hog(device, -1);
  free(handle->ring);
  free(handle->convert);
  free(handle);
  return -1;
}

static int ca_write_float(void *opaque, const float *input, int frames_in) {
  CoreAudioHandle *handle = (CoreAudioHandle *)opaque;
  if (!handle || frames_in <= 0) return 0;
  const size_t frames = (size_t)frames_in;
  const int channels = handle->channels;
  const double gain = atomic_load_explicit(&handle->volume, memory_order_relaxed);
  size_t done = 0;
  while (done < frames) {
    size_t chunk = frames - done;
    if (chunk > CA_CONVERT_FRAMES) chunk = CA_CONVERT_FRAMES;
    const float *src = input + done * (size_t)channels;
    size_t samples = chunk * (size_t)channels;
    uint8_t *dst = handle->convert;
    if (handle->is_float) {
      float *out = (float *)dst;
      double g = gain;
      for (size_t i = 0; i < samples; i++) out[i] = (float)(src[i] * g);
    } else if (handle->is_s16) {
      int16_t *out = (int16_t *)dst;
      for (size_t i = 0; i < samples; i++) {
        double v = src[i] * gain;
        if (v > 1.0) v = 1.0;
        if (v < -1.0) v = -1.0;
        out[i] = (int16_t)(v * 32767.0);
      }
    } else {
      int32_t *out = (int32_t *)dst;
      for (size_t i = 0; i < samples; i++) {
        double v = src[i] * gain;
        if (v > 1.0) v = 1.0;
        if (v < -1.0) v = -1.0;
        out[i] = (int32_t)(v * 2147483647.0);
      }
    }
    if (ca_push(handle, dst, chunk) != 0) return -1;
    done += chunk;
  }
  return (int)frames;
}

static int ca_write_int(void *opaque, const void *input, int frames, int bits) {
  CoreAudioHandle *handle = (CoreAudioHandle *)opaque;
  if (!handle || frames <= 0) return 0;
  const int channels = handle->channels;
  const double gain = atomic_load_explicit(&handle->volume, memory_order_relaxed);
  const size_t in_frame_bytes = (size_t)(bits == 16 ? 2 : 4) * (size_t)channels;
  const int simple = gain == 1.0 && in_frame_bytes == handle->frame_bytes &&
                     ((bits == 16 && handle->is_s16) || ((bits == 24 || bits == 32) && handle->is_s32));
  size_t total = (size_t)frames;
  size_t done = 0;
  while (done < total) {
    size_t chunk = total - done;
    if (chunk > CA_CONVERT_FRAMES) chunk = CA_CONVERT_FRAMES;
    const uint8_t *src = (const uint8_t *)input + done * in_frame_bytes;
    if (simple) {
      if (ca_push(handle, src, chunk) != 0) return -1;
      done += chunk;
      continue;
    }
    size_t samples = chunk * (size_t)channels;
    uint8_t *dst = handle->convert;
    if (bits == 16) {
      const int16_t *in = (const int16_t *)src;
      if (handle->is_float) {
        float *out = (float *)dst;
        for (size_t i = 0; i < samples; i++) out[i] = (float)((double)in[i] / 32768.0 * gain);
      } else if (handle->is_s16) {
        int16_t *out = (int16_t *)dst;
        for (size_t i = 0; i < samples; i++) {
          double v = (double)in[i] * gain;
          if (v > 32767.0) v = 32767.0;
          if (v < -32768.0) v = -32768.0;
          out[i] = (int16_t)v;
        }
      } else {
        int32_t *out = (int32_t *)dst;
        for (size_t i = 0; i < samples; i++) {
          double v = (double)in[i] * gain * 65536.0;
          if (v > 2147483647.0) v = 2147483647.0;
          if (v < -2147483648.0) v = -2147483648.0;
          out[i] = (int32_t)v;
        }
      }
    } else {
      /* 24-bit samples are stored high-aligned in int32 containers. */
      const int32_t *in = (const int32_t *)src;
      if (handle->is_float) {
        float *out = (float *)dst;
        for (size_t i = 0; i < samples; i++) out[i] = (float)((double)in[i] / 2147483648.0 * gain);
      } else if (handle->is_s32) {
        int32_t *out = (int32_t *)dst;
        for (size_t i = 0; i < samples; i++) {
          double v = (double)in[i] * gain;
          if (v > 2147483647.0) v = 2147483647.0;
          if (v < -2147483648.0) v = -2147483648.0;
          out[i] = (int32_t)v;
        }
      } else {
        int16_t *out = (int16_t *)dst;
        for (size_t i = 0; i < samples; i++) {
          double v = (double)in[i] / 65536.0 * gain;
          if (v > 32767.0) v = 32767.0;
          if (v < -32768.0) v = -32768.0;
          out[i] = (int16_t)v;
        }
      }
    }
    if (ca_push(handle, dst, chunk) != 0) return -1;
    done += chunk;
  }
  return frames;
}

static int ca_position(void *opaque, uint64_t *played) {
  CoreAudioHandle *handle = (CoreAudioHandle *)opaque;
  if (!handle) return -1;
  *played = atomic_load_explicit(&handle->rendered_frames, memory_order_relaxed);
  return 0;
}

static void ca_pause(void *opaque, int paused) {
  CoreAudioHandle *handle = (CoreAudioHandle *)opaque;
  if (!handle || !handle->unit) return;
  if (paused) {
    AudioOutputUnitStop(handle->unit);
  } else {
    AudioOutputUnitStart(handle->unit);
  }
}

static void ca_volume(void *opaque, double gain) {
  CoreAudioHandle *handle = (CoreAudioHandle *)opaque;
  if (!handle) return;
  if (gain < 0) gain = 0;
  if (gain > 1) gain = 1;
  atomic_store_explicit(&handle->volume, gain, memory_order_relaxed);
}

static void ca_flush(void *opaque) {
  CoreAudioHandle *handle = (CoreAudioHandle *)opaque;
  if (!handle) return;
  size_t write = atomic_load_explicit(&handle->write_pos, memory_order_acquire);
  atomic_store_explicit(&handle->read_pos, write, memory_order_release);
}

static int ca_drain(void *opaque) {
  CoreAudioHandle *handle = (CoreAudioHandle *)opaque;
  if (!handle) return 0;
  /* Wait for the render callback to consume the ring, then let the hardware
     buffer play out before reporting completion. */
  for (int i = 0; i < 3000; i++) {
    size_t write = atomic_load_explicit(&handle->write_pos, memory_order_acquire);
    size_t read = atomic_load_explicit(&handle->read_pos, memory_order_acquire);
    if (read >= write) break;
    usleep(1000);
  }
  usleep(50000);
  return 0;
}

static void ca_close(void *opaque) {
  CoreAudioHandle *handle = (CoreAudioHandle *)opaque;
  if (!handle) return;
  atomic_store_explicit(&handle->stopping, 1, memory_order_release);
  if (handle->unit) {
    AudioOutputUnitStop(handle->unit);
    AudioUnitUninitialize(handle->unit);
    AudioComponentInstanceDispose(handle->unit);
    handle->unit = NULL;
  }
  ca_restore_nominal_rate(handle);
  if (handle->hogged) ca_hog(handle->device_id, -1);
  free(handle->ring);
  free(handle->convert);
  free(handle);
}

/* ------------------------------------------------------------------ probe */

static int ca_collect_rates(AudioDeviceID device, int *rates, int max) {
  static const int standard[] = {44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000};
  AudioObjectPropertyAddress addr = {kAudioDevicePropertyAvailableNominalSampleRates, kAudioObjectPropertyScopeGlobal,
                                     CA_ELEMENT_MAIN};
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(device, &addr, 0, NULL, &size) != noErr || size == 0) {
    if (max > 0) rates[0] = 48000;
    return max > 0 ? 1 : 0;
  }
  int count = (int)(size / sizeof(AudioValueRange));
  AudioValueRange *ranges = (AudioValueRange *)malloc(size);
  if (!ranges) return 0;
  if (AudioObjectGetPropertyData(device, &addr, 0, NULL, &size, ranges) != noErr) {
    free(ranges);
    return 0;
  }
  int emitted = 0;
  for (size_t s = 0; s < sizeof(standard) / sizeof(standard[0]) && emitted < max; s++) {
    for (int i = 0; i < count; i++) {
      if ((double)standard[s] >= ranges[i].mMinimum - 0.5 && (double)standard[s] <= ranges[i].mMaximum + 0.5) {
        rates[emitted++] = standard[s];
        break;
      }
    }
  }
  free(ranges);
  if (emitted == 0 && max > 0) rates[emitted++] = 48000;
  return emitted;
}

static int ca_probe(const NaoeBackend *backend, char *json, size_t json_len) {
  (void)backend;
  AudioDeviceID devices[CA_MAX_DEVICES];
  int count = ca_list_devices(devices, CA_MAX_DEVICES);
  AudioDeviceID def = ca_default_output();
  size_t used = 0;
  int emitted = 0;
  used += (size_t)snprintf(json + used, json_len - used, "[");
  for (int i = 0; i < count; i++) {
    char name[512];
    char uid[512];
    if (ca_copy_string(devices[i], kAudioObjectPropertyName, name, sizeof(name)) != 0 || !name[0]) {
      snprintf(name, sizeof(name), "CoreAudio 设备 %u", (unsigned)devices[i]);
    }
    if (ca_copy_string(devices[i], kAudioDevicePropertyDeviceUID, uid, sizeof(uid)) != 0 || !uid[0]) {
      snprintf(uid, sizeof(uid), "id:%u", (unsigned)devices[i]);
    }
    int channels = ca_output_channels(devices[i]);
    if (channels <= 0) continue;
    if (channels > 2) channels = 2; /* NAOE reports stereo-capable endpoints. */
    int rates[8];
    int rate_count = ca_collect_rates(devices[i], rates, 8);
    char formats[4096];
    size_t f = 0;
    formats[0] = '\0';
    int first = 1;
    for (int r = 0; r < rate_count; r++) {
      for (int b = 0; b < 3; b++) {
        int bits = b == 0 ? 16 : b == 1 ? 24 : 32;
        const char *sf = bits == 16 ? "s16le" : bits == 24 ? "s24le" : "s32le";
        f += (size_t)snprintf(formats + f, sizeof(formats) - f, "%s{\"sampleRate\":%d,\"bits\":%d,\"channels\":%d,"
                                                                "\"sampleFormat\":\"%s\"}",
                              first ? "" : ",", rates[r], bits, channels, sf);
        first = 0;
        if (f + 128 > sizeof(formats)) break;
      }
      if (f + 128 > sizeof(formats)) break;
    }
    char esc_name[1024];
    char esc_uid[1024];
    naoe_json_escape(name, esc_name, sizeof(esc_name));
    naoe_json_escape(uid, esc_uid, sizeof(esc_uid));
    int is_default = def != kAudioObjectUnknown && devices[i] == def;
    used += (size_t)snprintf(json + used, json_len - used,
                             "%s{\"id\":\"%s\",\"name\":\"%s\",\"backend\":\"coreaudio\",\"isDefault\":%s,"
                             "\"formats\":[%s]}",
                             emitted ? "," : "", esc_uid, esc_name, is_default ? "true" : "false", formats);
    emitted++;
    if (used + 2048 > json_len) break;
  }
  used += (size_t)snprintf(json + used, json_len - used, "]");
  return emitted;
}

const NaoeBackend naoe_coreaudio_backend = {
    .name = "coreaudio",
    .open = ca_open,
    .write = ca_write_float,
    .write_int = ca_write_int,
    .position = ca_position,
    .pause = ca_pause,
    .volume = ca_volume,
    .flush = ca_flush,
    .drain = ca_drain,
    .close = ca_close,
    .probe = ca_probe,
};

#else /* !__APPLE__ */

static int ca_open(const NaoeConfig *cfg, NaoeFormat *actual, int *buffer_frames, void **out, char *err,
                   size_t err_len, char *supported, size_t supported_len) {
  (void)cfg;
  (void)actual;
  (void)buffer_frames;
  (void)out;
  (void)supported;
  (void)supported_len;
  snprintf(err, err_len, "此二进制不包含 CoreAudio 后端");
  return -1;
}

const NaoeBackend naoe_coreaudio_backend = {
    .name = "coreaudio",
    .open = ca_open,
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
