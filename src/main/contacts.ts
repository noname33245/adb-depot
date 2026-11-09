import type { ContactEntry } from "@shared/types";
import type { DeviceManager } from "./devices";

/**
 * 通讯录。
 *
 * 走 ContactsProvider 的 data/phones 表：一行一个号码，
 * 同一个人有多个号码就会出现多行，按联系人姓名合并。
 * 只读，不改动任何数据。
 */
export async function listContacts(devices: DeviceManager, serial: string): Promise<ContactEntry[]> {
  const out = await devices.shell(
    serial,
    "content query --uri content://com.android.contacts/data/phones --projection display_name:data1:data2 2>/dev/null",
    60_000,
  );

  const rows: ContactEntry[] = [];
  for (const line of out.split("\n")) {
    if (!line.startsWith("Row:")) continue;
    const fields: Record<string, string> = {};
    // 形如：Row: 0 display_name=保卫处, data1=051988970000, data2=2
    for (const part of line.slice(line.indexOf(" ") + 1).split(", ")) {
      const eq = part.indexOf("=");
      if (eq <= 0) continue;
      const key = part.slice(0, eq).trim();
      // 第一段会带 "0 display_name" 这种序号，去掉
      const name = key.includes(" ") ? key.slice(key.lastIndexOf(" ") + 1) : key;
      fields[name] = part.slice(eq + 1).trim();
    }
    const name = fields.display_name ?? "";
    const number = fields.data1 ?? "";
    if (!number) continue;
    rows.push({ name: name || number, number, type: phoneType(fields.data2) });
  }

  rows.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
  return rows;
}

/** data2 是号码类型：1 住宅、2 手机、3 工作…… */
function phoneType(raw: string | undefined): string {
  switch (Number(raw)) {
    case 1:
      return "住宅";
    case 2:
      return "手机";
    case 3:
      return "工作";
    case 12:
      return "其他";
    default:
      return "";
  }
}
