/**
 * First-run disclaimer gate. It must complete before the App constructs any
 * client/session or registers any playable surface.
 */
import * as vscode from "vscode";

export const DISCLAIMER_VERSION = "2026-11-04";

export const DISCLAIMER_TEXT = [
  "本扩展是非官方第三方工具，与网易云音乐及其关联公司没有隶属、授权或合作关系。",
  "",
  "1. 音频、歌词、封面、评论等内容的版权归网易云音乐及相应权利人所有。本扩展不托管、不拥有这些内容，只按用户自己的账号权限请求和播放。",
  "2. 请使用你本人合法拥有的账号与会员权限，并遵守网易云音乐的用户协议、版权规则和当地法律。不得用本扩展绕过付费、地区限制或其他访问控制。",
  "3. 请勿将缓存、下载内容或账号内容用于再分发、商业使用或其他侵权用途。",
  "4. 本扩展依赖非官方接口，可能随时失效、限流或导致账号异常；不保证可用性、音质、歌词或评论的完整性。",
  "5. 使用本扩展产生的账号、设备、数据与法律风险由使用者自行承担。在适用法律允许的范围内，作者不对间接损失承担责任。",
  "6. 如果权利人提出异议，应停止使用并移除相关内容。",
  "",
  "点击“同意并继续”表示你已阅读、理解并同意以上内容；不同意则本扩展不会启动，也不会进行登录或网络请求。",
].join("\n");

export async function ensureDisclaimer(context: vscode.ExtensionContext): Promise<boolean> {
  const accepted = context.globalState.get<string>("neteaseMusic.disclaimer.accepted") === DISCLAIMER_VERSION;
  if (accepted) return true;

  const choice = await vscode.window.showWarningMessage(
    "使用网易云音乐扩展前请阅读免责声明",
    {
      modal: true,
      detail: DISCLAIMER_TEXT,
    },
    "同意并继续",
    "不同意",
  );

  if (choice !== "同意并继续") {
    void vscode.window.showInformationMessage(
      "未同意免责声明，网易云音乐扩展不会启动。重新加载窗口后可再次选择。",
      "重新加载窗口",
    ).then((action) => {
      if (action === "重新加载窗口") void vscode.commands.executeCommand("workbench.action.reloadWindow");
    });
    return false;
  }

  await context.globalState.update("neteaseMusic.disclaimer.accepted", DISCLAIMER_VERSION);
  return true;
}
