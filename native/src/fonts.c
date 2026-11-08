/* Enumerate installed system font families for the settings dropdown. */
#include <stdio.h>
#include <string.h>

#if defined(_WIN32)
#include <windows.h>

static int CALLBACK font_callback(const ENUMLOGFONTEXW *lf, const TEXTMETRICW *tm, DWORD type, LPARAM lparam) {
  (void)tm;
  (void)lparam;
  if (!(type & TRUETYPE_FONTTYPE)) return 1;
  if (!lf || !lf->elfLogFont.lfFaceName[0]) return 1;
  char utf8[LF_FACESIZE * 4];
  int n = WideCharToMultiByte(CP_UTF8, 0, lf->elfLogFont.lfFaceName, -1, utf8, sizeof(utf8), NULL, NULL);
  if (n > 1) printf("FONT\t%s\n", utf8);
  return 1;
}

int naoe_fonts_main(void) {
  HDC dc = GetDC(NULL);
  if (!dc) return 1;
  LOGFONTW lf;
  memset(&lf, 0, sizeof(lf));
  lf.lfCharSet = DEFAULT_CHARSET;
  EnumFontFamiliesExW(dc, &lf, (FONTENUMPROCW)font_callback, 0, 0);
  ReleaseDC(NULL, dc);
  fflush(stdout);
  return 0;
}

#else

int naoe_fonts_main(void) { return 0; }

#endif
