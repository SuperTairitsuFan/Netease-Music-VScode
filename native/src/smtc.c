/*
 * Windows System Media Transport Controls (SMTC) helper.
 *
 * This is a separate long-lived mode of the native binary:
 *   native-audio-output.exe --smtc
 *
 * Protocol on stdin/stdout is line based and intentionally tiny:
 *   M <title> <artist>          update metadata
 *   S play|pause|stop           update playback status
 *   B <play|pause|next|previous|stop>   button event written to stdout
 *
 * The helper only controls the system media card. It never touches audio.
 */
#if defined(_WIN32)
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

typedef void *HSTRING_LOCAL;

typedef HRESULT(WINAPI *PFN_WindowsCreateString)(LPCWSTR, UINT32, HSTRING_LOCAL *);
typedef HRESULT(WINAPI *PFN_WindowsDeleteString)(HSTRING_LOCAL);
typedef HRESULT(WINAPI *PFN_RoGetActivationFactory)(HSTRING_LOCAL, REFIID, void **);
typedef HRESULT(WINAPI *PFN_RoInitialize)(int);
typedef void(WINAPI *PFN_RoUninitialize)(void);

static PFN_WindowsCreateString pWindowsCreateString;
static PFN_WindowsDeleteString pWindowsDeleteString;
static PFN_RoGetActivationFactory pRoGetActivationFactory;
static PFN_RoInitialize pRoInitialize;
static PFN_RoUninitialize pRoUninitialize;

#define VTBL(obj) (*(void ***)(obj))
#define CALL(obj, index, type, ...) ((type)(VTBL(obj)[index]))(obj, __VA_ARGS__)

static const GUID IID_SMTC_INTEROP = {0xddb0472d, 0xc911, 0x4a1f, {0x86, 0xd9, 0xdc, 0x3d, 0x71, 0xa9, 0x5f, 0x5a}};
static const GUID IID_SMTC = {0x99fa3ff4, 0x1742, 0x42a6, {0x90, 0x2e, 0x08, 0x7d, 0x41, 0xf9, 0x65, 0xec}};

static HWND g_window;
static void *g_smtc;
static void *g_display;
static void *g_music;
static int64_t g_button_token;
static CRITICAL_SECTION g_lock;
static volatile LONG g_stop;

typedef struct {
  void **vtbl;
  LONG ref;
} ButtonHandler;

static ButtonHandler g_handler;

static void emit_line(const char *line) {
  fputs(line, stdout);
  fputc('\n', stdout);
  fflush(stdout);
}

static HSTRING_LOCAL make_hstring(const wchar_t *value) {
  HSTRING_LOCAL result = NULL;
  if (pWindowsCreateString && value) pWindowsCreateString(value, (UINT32)wcslen(value), &result);
  return result;
}

static void free_hstring(HSTRING_LOCAL value) {
  if (pWindowsDeleteString && value) pWindowsDeleteString(value);
}

static int utf8_to_wide(const char *src, wchar_t *dst, int cap) {
  if (!src || !dst || cap <= 0) return 0;
  int n = MultiByteToWideChar(CP_UTF8, 0, src, -1, dst, cap);
  if (n <= 0) dst[0] = 0;
  return n;
}

/* ISystemMediaTransportControls vtable indices (IInspectable has 6 entries). */
enum {
  SMTC_GET_PLAYBACK_STATUS = 6,
  SMTC_PUT_PLAYBACK_STATUS = 7,
  SMTC_GET_DISPLAY = 8,
  SMTC_PUT_IS_ENABLED = 11,
  SMTC_PUT_IS_PLAY_ENABLED = 13,
  SMTC_PUT_IS_STOP_ENABLED = 15,
  SMTC_PUT_IS_PAUSE_ENABLED = 17,
  SMTC_PUT_IS_PREVIOUS_ENABLED = 25,
  SMTC_PUT_IS_NEXT_ENABLED = 27,
  SMTC_ADD_BUTTON_PRESSED = 32,
  SMTC_REMOVE_BUTTON_PRESSED = 33
};

enum {
  DISPLAY_PUT_TYPE = 7,
  DISPLAY_GET_MUSIC = 12,
  DISPLAY_UPDATE = 17
};

enum {
  MUSIC_PUT_TITLE = 7,
  MUSIC_PUT_ARTIST = 11
};

static HRESULT WINAPI handler_query_interface(ButtonHandler *self, REFIID riid, void **out) {
  (void)riid;
  if (!out) return E_POINTER;
  self->ref++;
  *out = self;
  return S_OK;
}

static HRESULT WINAPI handler_get_iids(ButtonHandler *self, ULONG *count, IID **iids) {
  (void)self;
  if (count) *count = 0;
  if (iids) *iids = NULL;
  return S_OK;
}

static HRESULT WINAPI handler_get_runtime_name(ButtonHandler *self, HSTRING_LOCAL *name) {
  (void)self;
  if (name) *name = NULL;
  return E_NOTIMPL;
}

static HRESULT WINAPI handler_get_trust(ButtonHandler *self, int *level) {
  (void)self;
  if (level) *level = 0;
  return S_OK;
}

static ULONG WINAPI handler_add_ref(ButtonHandler *self) {
  return (ULONG)InterlockedIncrement(&self->ref);
}

static ULONG WINAPI handler_release(ButtonHandler *self) {
  LONG value = InterlockedDecrement(&self->ref);
  return (ULONG)value;
}

static HRESULT WINAPI handler_invoke(ButtonHandler *self, void *sender, void *args) {
  (void)self;
  (void)sender;
  if (!args) return S_OK;
  int button = -1;
  HRESULT hr = ((HRESULT(WINAPI *)(void *, int *))VTBL(args)[6])(args, &button);
  if (FAILED(hr)) return S_OK;
  const char *name = NULL;
  switch (button) {
    case 0: name = "play"; break;
    case 1: name = "pause"; break;
    case 2: name = "stop"; break;
    case 6: name = "next"; break;
    case 7: name = "previous"; break;
    default: break;
  }
  if (name) {
    char line[64];
    snprintf(line, sizeof(line), "B\t%s", name);
    emit_line(line);
  }
  return S_OK;
}

static void *g_handler_vtbl[] = {
  (void *)handler_query_interface,
  (void *)handler_add_ref,
  (void *)handler_release,
  (void *)handler_get_iids,
  (void *)handler_get_runtime_name,
  (void *)handler_get_trust,
  (void *)handler_invoke,
};

static void smtc_set_metadata(const char *title, const char *artist) {
  if (!g_display) return;
  if (!g_music) {
    ((HRESULT(WINAPI *)(void *, int))VTBL(g_display)[DISPLAY_PUT_TYPE])(g_display, 1);
    ((HRESULT(WINAPI *)(void *, void **))VTBL(g_display)[DISPLAY_GET_MUSIC])(g_display, &g_music);
  }
  if (!g_music) return;
  wchar_t wtitle[512];
  wchar_t wartist[512];
  utf8_to_wide(title ? title : "", wtitle, 512);
  utf8_to_wide(artist ? artist : "", wartist, 512);
  HSTRING_LOCAL htitle = make_hstring(wtitle);
  HSTRING_LOCAL hartist = make_hstring(wartist);
  EnterCriticalSection(&g_lock);
  ((HRESULT(WINAPI *)(void *, int))VTBL(g_display)[DISPLAY_PUT_TYPE])(g_display, 1);
  if (htitle) ((HRESULT(WINAPI *)(void *, HSTRING_LOCAL))VTBL(g_music)[MUSIC_PUT_TITLE])(g_music, htitle);
  if (hartist) ((HRESULT(WINAPI *)(void *, HSTRING_LOCAL))VTBL(g_music)[MUSIC_PUT_ARTIST])(g_music, hartist);
  ((HRESULT(WINAPI *)(void *))VTBL(g_display)[DISPLAY_UPDATE])(g_display);
  LeaveCriticalSection(&g_lock);
  free_hstring(htitle);
  free_hstring(hartist);
}

static void smtc_set_status(const char *status) {
  if (!g_smtc) return;
  int value = 2; /* Stopped */
  if (status && strcmp(status, "play") == 0) value = 3; /* Playing */
  else if (status && strcmp(status, "pause") == 0) value = 4; /* Paused */
  EnterCriticalSection(&g_lock);
  ((HRESULT(WINAPI *)(void *, int))VTBL(g_smtc)[SMTC_PUT_PLAYBACK_STATUS])(g_smtc, value);
  LeaveCriticalSection(&g_lock);
}

static LRESULT CALLBACK smtc_wndproc(HWND hwnd, UINT msg, WPARAM wparam, LPARAM lparam) {
  (void)hwnd;
  (void)wparam;
  (void)lparam;
  if (msg == WM_CLOSE) {
    PostQuitMessage(0);
    return 0;
  }
  if (msg == WM_HOTKEY) {
    const char *name = NULL;
    if (wparam == 1) name = "play";
    else if (wparam == 2) name = "pause";
    else if (wparam == 3) name = "next";
    else if (wparam == 4) name = "previous";
    if (name) {
      char line[64];
      snprintf(line, sizeof(line), "B\t%s", name);
      emit_line(line);
    }
    return 0;
  }
  return DefWindowProcW(hwnd, msg, wparam, lparam);
}

static HWND create_hidden_window(void) {
  WNDCLASSW wc;
  memset(&wc, 0, sizeof(wc));
  wc.lpfnWndProc = smtc_wndproc;
  wc.hInstance = GetModuleHandleW(NULL);
  wc.lpszClassName = L"NaoeSmtcWindow";
  RegisterClassW(&wc);
  return CreateWindowExW(0, L"NaoeSmtcWindow", L"NetEase Music SMTC", 0, 0, 0, 0, 0, NULL, NULL, wc.hInstance, NULL);
}

static DWORD WINAPI stdin_thread(LPVOID param) {
  (void)param;
  char line[2048];
  while (!g_stop && fgets(line, sizeof(line), stdin)) {
    size_t len = strlen(line);
    while (len && (line[len - 1] == '\n' || line[len - 1] == '\r')) line[--len] = 0;
    if (len == 0) continue;
    if (strcmp(line, "Q") == 0) break;
    if (line[0] == 'M' && (line[1] == '\t' || line[1] == ' ')) {
      char *title = line + 2;
      char *artist = strchr(title, '\t');
      if (artist) {
        *artist++ = 0;
        smtc_set_metadata(title, artist);
      } else {
        smtc_set_metadata(title, "");
      }
    } else if (line[0] == 'S' && (line[1] == '\t' || line[1] == ' ')) {
      smtc_set_status(line + 2);
    }
  }
  InterlockedExchange(&g_stop, 1);
  if (g_window) PostMessageW(g_window, WM_CLOSE, 0, 0);
  return 0;
}

static int load_combase(void) {
  HMODULE module = LoadLibraryW(L"combase.dll");
  if (!module) return -1;
  pWindowsCreateString = (PFN_WindowsCreateString)GetProcAddress(module, "WindowsCreateString");
  pWindowsDeleteString = (PFN_WindowsDeleteString)GetProcAddress(module, "WindowsDeleteString");
  pRoGetActivationFactory = (PFN_RoGetActivationFactory)GetProcAddress(module, "RoGetActivationFactory");
  pRoInitialize = (PFN_RoInitialize)GetProcAddress(module, "RoInitialize");
  pRoUninitialize = (PFN_RoUninitialize)GetProcAddress(module, "RoUninitialize");
  return (pWindowsCreateString && pWindowsDeleteString && pRoGetActivationFactory && pRoInitialize) ? 0 : -1;
}

int naoe_smtc_main(void) {
  if (load_combase() != 0) {
    fprintf(stderr, "smtc: combase unavailable\n");
    return 1;
  }
  pRoInitialize(0);
  g_window = create_hidden_window();
  if (!g_window) {
    fprintf(stderr, "smtc: hidden window failed\n");
    return 2;
  }
  HSTRING_LOCAL className = make_hstring(L"Windows.Media.SystemMediaTransportControls");
  void *interop = NULL;
  if (!className || FAILED(pRoGetActivationFactory(className, &IID_SMTC_INTEROP, &interop)) || !interop) {
    fprintf(stderr, "smtc: activation factory failed\n");
    free_hstring(className);
    DestroyWindow(g_window);
    return 3;
  }
  free_hstring(className);
  HRESULT hr = ((HRESULT(WINAPI *)(void *, HWND, REFIID, void **))VTBL(interop)[6])(interop, g_window, &IID_SMTC, &g_smtc);
  if (FAILED(hr) || !g_smtc) {
    fprintf(stderr, "smtc: GetForWindow failed (%08x)\n", (unsigned)hr);
    ((ULONG(WINAPI *)(void *))VTBL(interop)[2])(interop);
    DestroyWindow(g_window);
    return 4;
  }
  ((ULONG(WINAPI *)(void *))VTBL(interop)[2])(interop);

  InitializeCriticalSection(&g_lock);
  g_handler.vtbl = g_handler_vtbl;
  g_handler.ref = 1;

  ((HRESULT(WINAPI *)(void *, int))VTBL(g_smtc)[SMTC_PUT_IS_ENABLED])(g_smtc, 1);
  ((HRESULT(WINAPI *)(void *, int))VTBL(g_smtc)[SMTC_PUT_IS_PLAY_ENABLED])(g_smtc, 1);
  ((HRESULT(WINAPI *)(void *, int))VTBL(g_smtc)[SMTC_PUT_IS_PAUSE_ENABLED])(g_smtc, 1);
  ((HRESULT(WINAPI *)(void *, int))VTBL(g_smtc)[SMTC_PUT_IS_STOP_ENABLED])(g_smtc, 0);
  ((HRESULT(WINAPI *)(void *, int))VTBL(g_smtc)[SMTC_PUT_IS_PREVIOUS_ENABLED])(g_smtc, 1);
  ((HRESULT(WINAPI *)(void *, int))VTBL(g_smtc)[SMTC_PUT_IS_NEXT_ENABLED])(g_smtc, 1);

  hr = ((HRESULT(WINAPI *)(void *, void **))VTBL(g_smtc)[SMTC_GET_DISPLAY])(g_smtc, &g_display);
  if (SUCCEEDED(hr) && g_display) {
    HRESULT mh = ((HRESULT(WINAPI *)(void *, void **))VTBL(g_display)[DISPLAY_GET_MUSIC])(g_display, &g_music);
  }

  RegisterHotKey(g_window, 1, MOD_NOREPEAT, VK_MEDIA_PLAY_PAUSE);
  RegisterHotKey(g_window, 2, MOD_NOREPEAT, VK_MEDIA_STOP);
  RegisterHotKey(g_window, 3, MOD_NOREPEAT, VK_MEDIA_NEXT_TRACK);
  RegisterHotKey(g_window, 4, MOD_NOREPEAT, VK_MEDIA_PREV_TRACK);
  emit_line("R\tsmtc");
  HANDLE reader = CreateThread(NULL, 0, stdin_thread, NULL, 0, NULL);
  if (reader) CloseHandle(reader);

  MSG msg;
  while (GetMessageW(&msg, NULL, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }

  InterlockedExchange(&g_stop, 1);
  ((HRESULT(WINAPI *)(void *, int))VTBL(g_smtc)[SMTC_PUT_IS_ENABLED])(g_smtc, 0);
  if (g_music) ((ULONG(WINAPI *)(void *))VTBL(g_music)[2])(g_music);
  if (g_display) ((ULONG(WINAPI *)(void *))VTBL(g_display)[2])(g_display);
  if (g_smtc) ((ULONG(WINAPI *)(void *))VTBL(g_smtc)[2])(g_smtc);
  UnregisterHotKey(g_window, 1);
  UnregisterHotKey(g_window, 2);
  UnregisterHotKey(g_window, 3);
  UnregisterHotKey(g_window, 4);
  DeleteCriticalSection(&g_lock);
  DestroyWindow(g_window);
  pRoUninitialize();
  return 0;
}

#else

int naoe_smtc_main(void) { return 0; }

#endif
