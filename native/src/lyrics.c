/*
 * Desktop lyrics overlay for Windows.
 *
 * Run as:
 *   native-audio-output.exe --lyrics
 *
 * Stdin (UTF-8, tab separated):
 *   L  <current line>  <next line>
 *   P  play|pause
 *   C  <font> <size> <color> <opacity> <width> <height> <locked> <x> <y> <dual>
 *   Q
 *
 * Stdout:
 *   R  lyrics
 *   CMD <previous|playPause|next|queue|close>
 *   STYLE <size> <dual>
 *   LOCK <0|1>
 *   POS <x> <y>
 */
#if defined(_WIN32)
#include <windows.h>
#include <windowsx.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum {
  BTN_FONT_DOWN = 1,
  BTN_FONT_UP,
  BTN_DUAL,
  BTN_PREV,
  BTN_PLAY,
  BTN_NEXT,
  BTN_LOCK,
  BTN_QUEUE,
  BTN_CLOSE
};

typedef struct {
  RECT rect;
  int action;
  const wchar_t *label;
} ToolButton;

static HWND g_window;
static HWND g_input;
static HFONT g_font_main;
static HFONT g_font_sub;
static HFONT g_font_toolbar;
static CRITICAL_SECTION g_lock;
static wchar_t g_main[1024];
static wchar_t g_sub[1024];
static wchar_t g_font[128] = L"Microsoft YaHei UI";
static wchar_t g_font2[128] = L"Microsoft YaHei UI";
static COLORREF g_color = RGB(255, 255, 255);
static COLORREF g_color2 = RGB(205, 205, 205);
static int g_size = 30;
static int g_size2 = 22;
static int g_opacity = 85;
static int g_width = 900;
static int g_height = 220;
static int g_locked = 1;
static int g_dual = 1;
static int g_show_second = 1;
static int g_marquee_offset;
static int g_marquee_needed;
static int g_weight = 600;
static int g_weight2 = 400;
static int g_border_width = 1;
static COLORREF g_border_color = RGB(255, 255, 255);
static wchar_t g_font_file[1024];
static int g_font_loaded;
static int g_playing;
static int g_x = -1;
static int g_y = -1;
static volatile LONG g_quit;
static int g_hover;
static ToolButton g_buttons[9];

static int utf8_to_wide(const char *src, wchar_t *dst, int cap) {
  if (!src || !dst || cap <= 0) return 0;
  int n = MultiByteToWideChar(CP_UTF8, 0, src, -1, dst, cap);
  if (n <= 0) dst[0] = 0;
  return n;
}

static void apply_input_region(void);

static void emit_line(const char *line) {
  fputs(line, stdout);
  fputc('\n', stdout);
  fflush(stdout);
}

static void emit_style(void) {
  char line[64];
  snprintf(line, sizeof(line), "STYLE\t%d\t%d", g_size, g_dual);
  emit_line(line);
}

static void emit_lock(void) {
  char line[32];
  snprintf(line, sizeof(line), "LOCK\t%d", g_locked);
  emit_line(line);
}

static void clamp_window_position(int *x, int *y, int width, int height) {
  int left = GetSystemMetrics(SM_XVIRTUALSCREEN);
  int top = GetSystemMetrics(SM_YVIRTUALSCREEN);
  int right = left + GetSystemMetrics(SM_CXVIRTUALSCREEN);
  int bottom = top + GetSystemMetrics(SM_CYVIRTUALSCREEN);
  if (width > right - left) width = right - left;
  if (height > bottom - top) height = bottom - top;
  if (*x < left) *x = left;
  if (*y < top) *y = top;
  if (*x + width > right) *x = right - width;
  if (*y + height > bottom) *y = bottom - height;
}

static void apply_window_style(void) {
  if (!g_window) return;
  LONG_PTR ex = GetWindowLongPtrW(g_window, GWL_EXSTYLE);
  ex |= WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TRANSPARENT;
  SetWindowLongPtrW(g_window, GWL_EXSTYLE, ex);
  int sw = GetSystemMetrics(SM_CXSCREEN);
  int sh = GetSystemMetrics(SM_CYSCREEN);
  int width = g_width > 320 ? g_width : 900;
  int height = g_height > 120 ? g_height : 190;
  int x = g_x >= 0 ? g_x : (sw - width) / 2;
  int y = g_y >= 0 ? g_y : sh - height - 100;
  clamp_window_position(&x, &y, width, height);
  if (g_input) {
    SetWindowPos(g_input, HWND_TOPMOST, x, y, width, height, SWP_NOACTIVATE | SWP_SHOWWINDOW);
    apply_input_region();
  }
  SetWindowPos(g_window, HWND_TOPMOST, x, y, width, height, SWP_NOACTIVATE | SWP_SHOWWINDOW);
  SetLayeredWindowAttributes(g_window, RGB(0, 0, 0), (BYTE)(g_opacity * 255 / 100), LWA_COLORKEY | LWA_ALPHA);
  InvalidateRect(g_window, NULL, FALSE);
}

static void apply_input_region(void) {
  if (!g_input) return;
  RECT wr;
  GetWindowRect(g_input, &wr);
  int width = wr.right - wr.left;
  int height = wr.bottom - wr.top;
  HRGN region = CreateRectRgn(0, 0, width, g_locked ? 44 : height);
  SetWindowRgn(g_input, region, TRUE);
}

static void apply_fonts(void) {
  if (g_font_main) DeleteObject(g_font_main);
  if (g_font_sub) DeleteObject(g_font_sub);
  if (g_font_toolbar) DeleteObject(g_font_toolbar);
  if (!g_font_loaded && g_font_file[0]) {
    AddFontResourceExW(g_font_file, FR_PRIVATE, 0);
    g_font_loaded = 1;
  }
  g_font_main = CreateFontW(-g_size, 0, 0, 0, g_weight, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
                            OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                            DEFAULT_PITCH | FF_DONTCARE, g_font);
  g_font_sub = CreateFontW(-g_size2, 0, 0, 0, g_weight2, FALSE, FALSE,
                           FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                           CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_DONTCARE, g_font2);
  g_font_toolbar = CreateFontW(-14, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
                               OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                               DEFAULT_PITCH | FF_DONTCARE, L"Microsoft YaHei UI");
}

static void layout_buttons(int width, int height) {
  const wchar_t *labels[] = {L"A-", L"A+", L"上一首", L"播放", L"下一首", L"锁定", L"关闭"};
  const int actions[] = {BTN_FONT_DOWN, BTN_FONT_UP, BTN_PREV, BTN_PLAY, BTN_NEXT, BTN_LOCK, BTN_CLOSE};
  int top = 9;
  int each = 38;
  int gap = 2;
  int total = each * 7 + gap * 6;
  int left = (width - total) / 2;
  if (left < 10) left = 10;
  for (int i = 0; i < 7; i++) {
    g_buttons[i].rect.left = left;
    g_buttons[i].rect.top = top;
    g_buttons[i].rect.right = left + each;
    g_buttons[i].rect.bottom = top + 32;
    g_buttons[i].action = actions[i];
    g_buttons[i].label = labels[i];
    left += each + gap;
  }
  g_buttons[3].label = g_playing ? L"暂停" : L"播放";
  g_buttons[5].label = g_locked ? L"解锁" : L"锁定";
}

static void draw_icon(HDC dc, RECT r, int action) {
  int cx = (r.left + r.right) / 2;
  int cy = (r.top + r.bottom) / 2;
  int size = (r.bottom - r.top) - 18;
  if (size < 12) size = 12;
  HPEN pen = CreatePen(PS_SOLID, 2, RGB(235, 235, 235));
  HBRUSH brush = CreateSolidBrush(RGB(235, 235, 235));
  HGDIOBJ old_pen = SelectObject(dc, pen);
  HGDIOBJ old_brush = SelectObject(dc, brush);
  switch (action) {
    case BTN_FONT_DOWN:
    case BTN_FONT_UP: {
      SelectObject(dc, g_font_toolbar);
      SetTextColor(dc, RGB(235, 235, 235));
      SetBkMode(dc, TRANSPARENT);
      DrawTextW(dc, action == BTN_FONT_DOWN ? L"A-" : L"A+", -1, &r, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
      break;
    }
    case BTN_DUAL: {
      int half = size / 2;
      MoveToEx(dc, cx - half, cy - 5, NULL);
      LineTo(dc, cx + half, cy - 5);
      MoveToEx(dc, cx - half, cy + 5, NULL);
      LineTo(dc, cx + half, cy + 5);
      break;
    }
    case BTN_PREV: {
      MoveToEx(dc, cx - size / 2, cy - size / 2, NULL);
      LineTo(dc, cx - size / 2, cy + size / 2);
      POINT pts[3] = {{cx + size / 2, cy - size / 2}, {cx + size / 2, cy + size / 2}, {cx - size / 4, cy}};
      Polygon(dc, pts, 3);
      break;
    }
    case BTN_PLAY: {
      if (g_playing) {
        Rectangle(dc, cx - size / 3 - 3, cy - size / 2, cx - 3, cy + size / 2);
        Rectangle(dc, cx + 3, cy - size / 2, cx + size / 3 + 3, cy + size / 2);
      } else {
        POINT pts[3] = {{cx - size / 3, cy - size / 2}, {cx - size / 3, cy + size / 2}, {cx + size / 2, cy}};
        Polygon(dc, pts, 3);
      }
      break;
    }
    case BTN_NEXT: {
      POINT pts[3] = {{cx - size / 2, cy - size / 2}, {cx - size / 2, cy + size / 2}, {cx + size / 4, cy}};
      Polygon(dc, pts, 3);
      MoveToEx(dc, cx + size / 2, cy - size / 2, NULL);
      LineTo(dc, cx + size / 2, cy + size / 2);
      break;
    }
    case BTN_LOCK: {
      SelectObject(dc, GetStockObject(NULL_BRUSH));
      Rectangle(dc, cx - size / 2, cy - 2, cx + size / 2, cy + size / 2);
      if (g_locked) {
        Arc(dc, cx - size / 3, cy - size / 2 - 2, cx + size / 3, cy, cx - size / 3, cy - 2, cx + size / 3, cy - 2);
      } else {
        Arc(dc, cx - size / 3 - 4, cy - size / 2 - 2, cx + size / 3 - 4, cy, cx - size / 3 - 4, cy - 2, cx + size / 3 + 4, cy - 2);
      }
      break;
    }
    case BTN_QUEUE: {
      int left = cx - size / 2;
      int right = cx + size / 2;
      for (int i = 0; i < 3; i++) {
        int y = cy - size / 3 + i * (size / 3);
        Ellipse(dc, left, y - 2, left + 4, y + 2);
        MoveToEx(dc, left + 7, y, NULL);
        LineTo(dc, right, y);
      }
      break;
    }
    case BTN_CLOSE: {
      MoveToEx(dc, cx - size / 2, cy - size / 2, NULL);
      LineTo(dc, cx + size / 2, cy + size / 2);
      MoveToEx(dc, cx + size / 2, cy - size / 2, NULL);
      LineTo(dc, cx - size / 2, cy + size / 2);
      break;
    }
    default:
      break;
  }
  SelectObject(dc, old_pen);
  SelectObject(dc, old_brush);
  DeleteObject(pen);
  DeleteObject(brush);
}

static void draw_toolbar(HDC dc, int width, int height) {
  layout_buttons(width, height);
  HBRUSH bar = CreateSolidBrush(RGB(18, 18, 18));
  HPEN bar_pen = CreatePen(PS_SOLID, 1, RGB(18, 18, 18));
  HGDIOBJ old_brush = SelectObject(dc, bar);
  HGDIOBJ old_pen = SelectObject(dc, bar_pen);
  RoundRect(dc, g_buttons[0].rect.left - 5, 5, g_buttons[6].rect.right + 5, 43, 12, 12);
  SelectObject(dc, old_brush);
  SelectObject(dc, old_pen);
  DeleteObject(bar);
  DeleteObject(bar_pen);
  for (int i = 0; i < 7; i++) {
    RECT icon = g_buttons[i].rect;
    InflateRect(&icon, -6, -4);
    draw_icon(dc, icon, g_buttons[i].action);
  }
}

static LRESULT CALLBACK input_wndproc(HWND hwnd, UINT msg, WPARAM wparam, LPARAM lparam) {
  static int dragging;
  static POINT drag_start;
  static POINT window_start;
  if (msg == WM_TIMER && wparam == 1) {
    POINT pt;
    RECT wr;
    GetCursorPos(&pt);
    GetWindowRect(hwnd, &wr);
    int inside = pt.x >= wr.left && pt.x < wr.right && pt.y >= wr.top && pt.y < wr.bottom;
    int hover = inside && !g_locked;
    if (hover != g_hover) {
      g_hover = hover;
      if (g_window) InvalidateRect(g_window, NULL, FALSE);
    }
    if (g_marquee_needed) {
      g_marquee_offset += 2;
      if (g_window) InvalidateRect(g_window, NULL, FALSE);
    }
    return 0;
  }
  if (msg == WM_MOUSEMOVE) {
    int x = GET_X_LPARAM(lparam);
    int y = GET_Y_LPARAM(lparam);
    if (dragging) {
      POINT pt;
      GetCursorPos(&pt);
      int nx = window_start.x + pt.x - drag_start.x;
      int ny = window_start.y + pt.y - drag_start.y;
      clamp_window_position(&nx, &ny, g_width, g_height);
      g_x = nx;
      g_y = ny;
      SetWindowPos(g_window, HWND_TOPMOST, nx, ny, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE);
      SetWindowPos(hwnd, HWND_TOPMOST, nx, ny, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE);
      if (g_window) InvalidateRect(g_window, NULL, FALSE);
    } else if (!g_locked && y > 44) {
      SetCursor(LoadCursor(NULL, IDC_SIZEALL));
    } else {
      SetCursor(LoadCursor(NULL, IDC_HAND));
    }
    return 0;
  }
  if (msg == WM_LBUTTONDOWN) {
    int x = GET_X_LPARAM(lparam);
    int y = GET_Y_LPARAM(lparam);
    if (y <= 44) {
      if (g_window) SendMessageW(g_window, WM_LBUTTONDOWN, 0, MAKELPARAM(x, y));
      return 0;
    }
    if (g_locked) return 0;
    dragging = 1;
    SetCapture(hwnd);
    GetCursorPos(&drag_start);
    RECT wr;
    GetWindowRect(hwnd, &wr);
    window_start.x = wr.left;
    window_start.y = wr.top;
    return 0;
  }
  if (msg == WM_LBUTTONUP) {
    if (dragging) {
      dragging = 0;
      ReleaseCapture();
      char out[64];
      snprintf(out, sizeof(out), "POS\t%d\t%d", g_x, g_y);
      emit_line(out);
    }
    return 0;
  }
  if (msg == WM_CLOSE) {
    PostQuitMessage(0);
    return 0;
  }
  return DefWindowProcW(hwnd, msg, wparam, lparam);
}

static HWND create_input_window(void) {
  WNDCLASSW wc;
  memset(&wc, 0, sizeof(wc));
  wc.lpfnWndProc = input_wndproc;
  wc.hInstance = GetModuleHandleW(NULL);
  wc.hCursor = LoadCursor(NULL, IDC_ARROW);
  wc.lpszClassName = L"NaoeLyricsInput";
  RegisterClassW(&wc);
  DWORD ex = WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_LAYERED;
  HWND hwnd = CreateWindowExW(ex, L"NaoeLyricsInput", L"NetEase Lyrics Input", WS_POPUP, 0, 0, 900, 220,
                              NULL, NULL, wc.hInstance, NULL);
  if (hwnd) SetLayeredWindowAttributes(hwnd, 0, 1, LWA_ALPHA);
  if (hwnd) SetTimer(hwnd, 1, 100, NULL);
  return hwnd;
}

static LRESULT CALLBACK lyrics_wndproc(HWND hwnd, UINT msg, WPARAM wparam, LPARAM lparam) {
  (void)wparam;
  if (msg == WM_NCHITTEST) {
    POINT pt = {GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam)};
    ScreenToClient(hwnd, &pt);
    if (pt.y <= 44) return HTCLIENT;
    if (g_locked) return HTTRANSPARENT;
    return HTCAPTION;
  }
  if (msg == WM_SETCURSOR) {
    if (LOWORD(lparam) == HTCLIENT) {
      POINT pt;
      GetCursorPos(&pt);
      ScreenToClient(hwnd, &pt);
      if (pt.y > 44 && !g_locked) SetCursor(LoadCursor(NULL, IDC_SIZEALL));
      else SetCursor(LoadCursor(NULL, IDC_HAND));
      return TRUE;
    }
  }
  if (msg == WM_MOUSEMOVE) {
    if (!g_locked && GET_Y_LPARAM(lparam) > 44) SetCursor(LoadCursor(NULL, IDC_SIZEALL));
    return 0;
  }
  if (msg == WM_TIMER && wparam == 1) {
    POINT pt;
    RECT wr;
    GetCursorPos(&pt);
    GetWindowRect(hwnd, &wr);
    int inside = pt.x >= wr.left && pt.x < wr.right && pt.y >= wr.top && pt.y < wr.bottom;
    if (inside != g_hover) {
      g_hover = inside;
      InvalidateRect(hwnd, NULL, FALSE);
    }
    return 0;
  }
  if (msg == WM_LBUTTONDOWN) {
    int x = GET_X_LPARAM(lparam);
    int y = GET_Y_LPARAM(lparam);
    for (int i = 0; i < 7; i++) {
      if (x >= g_buttons[i].rect.left && x <= g_buttons[i].rect.right && y >= g_buttons[i].rect.top &&
          y <= g_buttons[i].rect.bottom) {
        switch (g_buttons[i].action) {
          case BTN_FONT_DOWN:
            g_size = g_size > 14 ? g_size - 2 : 14;
            apply_fonts();
            emit_style();
            InvalidateRect(hwnd, NULL, FALSE);
            break;
          case BTN_FONT_UP:
            g_size = g_size < 96 ? g_size + 2 : 96;
            apply_fonts();
            emit_style();
            InvalidateRect(hwnd, NULL, FALSE);
            break;
          case BTN_DUAL:
            g_dual = g_dual ? 0 : 1;
            emit_style();
            InvalidateRect(hwnd, NULL, FALSE);
            break;
          case BTN_PREV:
            emit_line("CMD\tprevious");
            break;
          case BTN_PLAY:
            emit_line("CMD\tplayPause");
            break;
          case BTN_NEXT:
            emit_line("CMD\tnext");
            break;
          case BTN_LOCK:
            g_locked = g_locked ? 0 : 1;
            emit_lock();
            apply_window_style();
            break;
          case BTN_CLOSE:
            emit_line("CMD\tclose");
            PostMessageW(hwnd, WM_CLOSE, 0, 0);
            break;
          default:
            break;
        }
        return 0;
      }
    }
    return 0;
  }
  if (msg == WM_PAINT) {
    PAINTSTRUCT ps;
    HDC dc = BeginPaint(hwnd, &ps);
    RECT rect;
    GetClientRect(hwnd, &rect);
    HBRUSH background = CreateSolidBrush(RGB(0, 0, 0));
    FillRect(dc, &rect, background);
    DeleteObject(background);
    wchar_t main_line[1024];
    wchar_t sub_line[1024];
    EnterCriticalSection(&g_lock);
    wcscpy_s(main_line, 1024, g_main);
    wcscpy_s(sub_line, 1024, g_sub);
    LeaveCriticalSection(&g_lock);

    if (main_line[0]) {
      wchar_t combined[2048];
      if (sub_line[0]) swprintf(combined, 2048, L"%ls\n%ls", main_line, sub_line);
      else wcsncpy_s(combined, 2048, main_line, _TRUNCATE);
      SelectObject(dc, g_font_main);
      SetBkMode(dc, TRANSPARENT);
      SetTextColor(dc, g_color);
      RECT main_rect = {28, 44, rect.right - 28, rect.bottom - 8};
      DrawTextW(dc, combined, -1, &main_rect, DT_CENTER | DT_TOP | DT_NOPREFIX);
      g_marquee_needed = 0;
    }
    draw_toolbar(dc, rect.right, rect.bottom);
    EndPaint(hwnd, &ps);
    return 0;
  }
  if (msg == WM_EXITSIZEMOVE) {
    RECT rect;
    if (GetWindowRect(hwnd, &rect)) {
      g_x = rect.left;
      g_y = rect.top;
      char out[64];
      snprintf(out, sizeof(out), "POS\t%d\t%d", g_x, g_y);
      emit_line(out);
    }
    return 0;
  }
  if (msg == WM_CLOSE || msg == WM_DESTROY) {
    PostQuitMessage(0);
    return 0;
  }
  return DefWindowProcW(hwnd, msg, wparam, lparam);
}

static HWND create_overlay(void) {
  WNDCLASSW wc;
  memset(&wc, 0, sizeof(wc));
  wc.lpfnWndProc = lyrics_wndproc;
  wc.hInstance = GetModuleHandleW(NULL);
  wc.hCursor = LoadCursor(NULL, IDC_ARROW);
  wc.lpszClassName = L"NaoeLyricsOverlay";
  RegisterClassW(&wc);
  DWORD ex_style = WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_LAYERED | WS_EX_NOACTIVATE;
  return CreateWindowExW(ex_style, L"NaoeLyricsOverlay", L"NetEase Lyrics", WS_POPUP, 0, 0, 900, 190,
                         NULL, NULL, wc.hInstance, NULL);
}

static void apply_style_command(char *payload) {
  char *fields[18] = {0};
  int count = 0;
  char *cursor = payload;
  while (cursor && count < 18) {
    fields[count++] = cursor;
    char *tab = strchr(cursor, '\t');
    if (!tab) break;
    *tab = 0;
    cursor = tab + 1;
  }
  if (count >= 1 && fields[0]) {
    wchar_t font[128];
    utf8_to_wide(fields[0], font, 128);
    wcscpy_s(g_font, 128, font);
  }
  if (count >= 2 && fields[1]) g_size = atoi(fields[1]);
  if (count >= 3 && fields[2]) {
    unsigned long value = strtoul(fields[2], NULL, 16);
    g_color = RGB((value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff);
  }
  if (count >= 4 && fields[3]) g_opacity = atoi(fields[3]);
  if (count >= 5 && fields[4]) g_width = atoi(fields[4]);
  if (count >= 6 && fields[5]) g_height = atoi(fields[5]);
  if (count >= 7 && fields[6]) g_locked = atoi(fields[6]) ? 1 : 0;
  if (count >= 8 && fields[7]) g_x = atoi(fields[7]);
  if (count >= 9 && fields[8]) g_y = atoi(fields[8]);
  if (count >= 10 && fields[9]) g_dual = atoi(fields[9]) ? 1 : 0;
  if (count >= 11 && fields[10]) g_weight = atoi(fields[10]);
  if (count >= 12 && fields[11]) {
    wchar_t file[1024];
    utf8_to_wide(fields[11], file, 1024);
    if (wcscmp(file, g_font_file) != 0) {
      if (g_font_loaded && g_font_file[0]) RemoveFontResourceExW(g_font_file, FR_PRIVATE, 0);
      wcscpy_s(g_font_file, 1024, file);
      g_font_loaded = 0;
    }
  }
  if (count >= 13 && fields[12]) {
    wchar_t font[128];
    utf8_to_wide(fields[12], font, 128);
    if (font[0]) wcscpy_s(g_font2, 128, font);
  }
  if (count >= 14 && fields[13]) g_size2 = atoi(fields[13]);
  if (count >= 15 && fields[14]) {
    unsigned long value = strtoul(fields[14], NULL, 16);
    g_color2 = RGB((value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff);
  }
  if (count >= 16 && fields[15]) g_weight2 = atoi(fields[15]);
  if (count >= 17 && fields[16]) g_border_width = atoi(fields[16]);
  if (count >= 18 && fields[17]) {
    unsigned long value = strtoul(fields[17], NULL, 16);
    g_border_color = RGB((value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff);
  }
  if (g_size < 14) g_size = 14;
  if (g_size > 96) g_size = 96;
  if (g_size2 < 12) g_size2 = 12;
  if (g_size2 > 96) g_size2 = 96;
  if (g_weight2 < 100) g_weight2 = 100;
  if (g_weight2 > 900) g_weight2 = 900;
  if (g_border_width < 0) g_border_width = 0;
  if (g_border_width > 8) g_border_width = 8;
  if (g_opacity < 10) g_opacity = 10;
  if (g_opacity > 100) g_opacity = 100;
  apply_fonts();
  apply_window_style();
}

static DWORD WINAPI lyrics_stdin_thread(LPVOID param) {
  (void)param;
  char line[4096];
  while (!g_quit && fgets(line, sizeof(line), stdin)) {
    size_t len = strlen(line);
    while (len && (line[len - 1] == '\n' || line[len - 1] == '\r')) line[--len] = 0;
    if (strcmp(line, "Q") == 0) break;
    if (line[0] == 'C' && (line[1] == '\t' || line[1] == ' ')) {
      apply_style_command(line + 2);
      continue;
    }
    if (line[0] == 'D' && (line[1] == '\t' || line[1] == ' ')) {
      g_show_second = atoi(line + 2) ? 1 : 0;
      if (g_window) InvalidateRect(g_window, NULL, FALSE);
      continue;
    }
    if (line[0] == 'P' && (line[1] == '\t' || line[1] == ' ')) {
      g_playing = strcmp(line + 2, "play") == 0;
      if (g_window) InvalidateRect(g_window, NULL, FALSE);
      continue;
    }
    if (line[0] != 'L' || (line[1] != '\t' && line[1] != ' ')) continue;
    char *current = line + 2;
    char *next = strchr(current, '\t');
    if (next) *next++ = 0;
    wchar_t main_line[1024];
    wchar_t sub_line[1024];
    utf8_to_wide(current, main_line, 1024);
    utf8_to_wide(next ? next : "", sub_line, 1024);
    EnterCriticalSection(&g_lock);
    wcscpy_s(g_main, 1024, main_line);
    wcscpy_s(g_sub, 1024, sub_line);
    g_marquee_offset = 0;
    LeaveCriticalSection(&g_lock);
    if (g_window) RedrawWindow(g_window, NULL, NULL, RDW_INVALIDATE | RDW_UPDATENOW | RDW_ALLCHILDREN);
  }
  InterlockedExchange(&g_quit, 1);
  if (g_window) PostMessageW(g_window, WM_CLOSE, 0, 0);
  return 0;
}

int naoe_lyrics_main(void) {
  InitializeCriticalSection(&g_lock);
  apply_fonts();
  g_window = create_overlay();
  if (!g_window) {
    fprintf(stderr, "lyrics: window creation failed\n");
    return 1;
  }
  g_input = create_input_window();
  apply_window_style();
  emit_line("R\tlyrics");
  HANDLE reader = CreateThread(NULL, 0, lyrics_stdin_thread, NULL, 0, NULL);
  if (reader) CloseHandle(reader);

  MSG msg;
  while (GetMessageW(&msg, NULL, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
  InterlockedExchange(&g_quit, 1);
  if (g_input) { KillTimer(g_input, 1); DestroyWindow(g_input); g_input = NULL; }
  if (g_font_main) DeleteObject(g_font_main);
  if (g_font_sub) DeleteObject(g_font_sub);
  if (g_font_toolbar) DeleteObject(g_font_toolbar);
  if (g_font_loaded && g_font_file[0]) RemoveFontResourceExW(g_font_file, FR_PRIVATE, 0);
  DeleteCriticalSection(&g_lock);
  return 0;
}

#else

int naoe_lyrics_main(void) { return 0; }

#endif
