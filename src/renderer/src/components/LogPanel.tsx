import { locale } from "@shared/i18n";
import type { DeviceResult } from "@shared/types";
import { useT } from "../settings";

export interface LogEntry {
  id: string;
  time: Date;
  title: string;
  results: (DeviceResult & { name: string })[];
}

export function LogPanel({
  entries,
  onClear,
  height,
  onHeight,
}: {
  entries: LogEntry[];
  onClear: () => void;
  height: number;
  onHeight: (h: number) => void;
}) {
  const t = useT();
  /** 拖上边缘改高度；双击恢复默认 200。 */
  const startDrag = (e: React.PointerEvent): void => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    const move = (ev: PointerEvent): void => {
      onHeight(Math.min(620, Math.max(90, startH - (ev.clientY - startY))));
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <section className="log" style={{ height }}>
      <div
        className="log-grip"
        title="拖动调整日志高度（双击恢复默认）"
        onPointerDown={startDrag}
        onDoubleClick={() => onHeight(200)}
      />
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
