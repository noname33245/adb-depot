/**
 * `dumpsys notification --noredact` 输出解析（纯函数，方便单独验证）。
 *
 * 不同 ROM 打印格式差别很大：
 * - AOSP:  `NotificationRecord{... pkg=com.x ...}` / `android.title=String: 标题`
 * - MIUI:  `NotificationRecord(0x...: pkg=com.x ...)` / `android.title=String (标题)`
 * 两种都要认，认不出来就跳过这条，不能把整段输出当成一条通知。
 */

export interface ParsedNotification {
  serial: string;
  pkg: string;
  title: string;
  text: string;
}

/** MIUI 的「String (内容)」「SpannableString (内容)」以及 AOSP 的「String: 内容」。 */
function clean(v: string | undefined): string {
  if (!v) return "";
  const s = v.trim();
  // MIUI 的括号包装：括号里就是正文，别再拿 Bundle 的尾部规则去削它
  const wrapped = /^(?:String|SpannableString|CharSequence|String16)\s*\((.*)\)\s*$/s.exec(s);
  if (wrapped) return wrapped[1]!.replace(/\s{2,}/g, " ").trim().slice(0, 300);
  return s
    .replace(/,\s*android\..*$/s, "")
    .replace(/^(?:String|SpannableString|CharSequence):\s*/, "")
    .replace(/[}\],]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 300);
}

function field(block: string, key: string): string {
  const m = new RegExp(`android\\.${key}=(?:[^\\n\\r]+)`, "g").exec(block);
  return clean(m?.[0]?.slice(`android.${key}=`.length));
}

export function notificationKey(n: ParsedNotification): string {
  return `${n.serial}|${n.pkg}|${n.title}|${n.text}`;
}

export function parseNotifications(out: string, serial: string): ParsedNotification[] {
  const result: ParsedNotification[] = [];
  // AOSP 用花括号，MIUI 用圆括号；两种都作为记录分界
  for (const block of out.split(/(?=\bNotificationRecord[({])/)) {
    if (!/\bNotificationRecord[({]/.test(block)) continue;
    const pkg = /\bpkg=([\w.]+)/.exec(block)?.[1] ?? "unknown";
    const title = field(block, "title") || field(block, "subText");
    const text = field(block, "bigText") || field(block, "text");
    if (!title && !text) continue;
    result.push({ serial, pkg, title, text });
  }
  return result;
}
