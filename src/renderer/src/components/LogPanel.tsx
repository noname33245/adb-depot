import { locale } from "@shared/i18n";
import type { DeviceResult } from "@shared/types";
import { useT } from "../settings";

export interface LogEntry {
  id: string;
  time: Date;
  title: string;
  results: (DeviceResult & { name: string })[];
}

export function LogPanel({ entries, onClear }: { entries: LogEntry[]; onClear: () => void }) {
  const t = useT();
  return (
    <section className="log">
      <header className="log-header">
        <h3>{t("log.title")}</h3>
        {entries.length > 0 && (
          <button className="link" onClick={onClear}>
            {t("log.clear")}
          </button>
        )}
      </header>
      <div className="log-body">
        {entries.length === 0 && <p className="muted">{t("log.empty")}</p>}
        {entries.map((e) => {
          const ok = e.results.filter((r) => r.success).length;
          // 手敲的 shell 命令默认展开，不然只看到一行标题，以为没有返回
          const openByDefault = e.title.startsWith("$") || ok !== e.results.length;
          return (
            <details key={e.id} className="log-entry" open={openByDefault}>
              <summary>
                <span className="muted">{e.time.toLocaleTimeString(locale())}</span> {e.title}{" "}
                <span className={ok === e.results.length ? "ok" : "fail"}>
                  {ok}/{e.results.length}
                </span>
              </summary>
              {e.results.map((r) => (
                <div key={r.serial} className={`log-result ${r.success ? "ok" : "fail"}`}>
                  <div className="log-device">{r.name}</div>
                  {r.success
                    ? (r.output ? <pre>{r.output}</pre> : <pre className="muted">{t("log.noOutput")}</pre>)
                    : <pre>{r.error}</pre>}
                </div>
              ))}
            </details>
          );
        })}
      </div>
    </section>
  );
}
