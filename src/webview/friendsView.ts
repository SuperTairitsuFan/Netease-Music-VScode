export interface FriendMessageLike {
  fromUserId: number;
  content: string;
  time: number;
  roomId?: string;
  inviterId?: string;
  inviteUrl?: string;
}

export interface FriendMessageRenderOptions {
  accountId?: number;
  escapeHtml: (value: string) => string;
  emptyHtml: (message: string) => string;
  formatTime: (time: number) => string;
}

export function friendInviteUrl(message: { inviteUrl?: string; roomId?: string; inviterId?: string }): string {
  if (message.roomId && message.inviterId) {
    return `https://st.music.163.com/listen-together/share/index.html?roomId=${encodeURIComponent(message.roomId)}&inviterId=${encodeURIComponent(message.inviterId)}`;
  }
  if (message.inviteUrl && /listen-together|roomId=/i.test(message.inviteUrl)) return message.inviteUrl;
  return "";
}

export function renderFriendMessages(messages: FriendMessageLike[], options: FriendMessageRenderOptions): string {
  if (!messages.length) return options.emptyHtml("还没有消息，打个招呼吧");
  return messages
    .map((message) => {
      const esc = options.escapeHtml;
      const inviteUrl = friendInviteUrl(message);
      const invite = inviteUrl
        ? `<div class="friend-invite-link"><span>${esc(inviteUrl)}</span><button class="btn small" data-act="copyFriendInvite" data-url="${esc(inviteUrl)}">复制链接</button><button class="btn small primary" data-act="joinListenMessage" data-url="${esc(inviteUrl)}">加入</button></div>`
        : /一起听/.test(message.content)
          ? `<div class="friend-invite-hint">该消息只返回了卡片文字，没有 roomId 或邀请链接；请让对方发送普通链接。</div>`
          : "";
      return `<div class="friend-message ${message.fromUserId === options.accountId ? "mine" : ""}"><div class="friend-bubble">${esc(message.content)}</div>${invite}<div class="friend-time">${message.time ? options.formatTime(message.time) : ""}</div></div>`;
    })
    .join("");
}
