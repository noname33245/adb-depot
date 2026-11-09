import { useEffect, useRef, useState } from "react";
import type { ThemeMode } from "@shared/types";
import { useSettings } from "../settings";

const OPTIONS: { value: ThemeMode; label: string; desc: string; icon: string }[] = [
  { value: "dark", label: "深色", desc: "固定深色界面", icon: "☾" },
  { value: "light", label: "浅色", desc: "固定浅色界面", icon: "☀" },
  { value: "system", label: "跟随 Windows", desc: "随系统深色模式自动切换", icon: "◐" },
];

/** 顶栏的三档主题切换，和设置弹窗共用同一份设置。 */
export function ThemeMenu() {
  const { settings, update } = useSettings();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const current = OPTIONS.find((o) => o.value === settings.theme) ?? OPTIONS[0]!;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="theme-wrap" ref={wrap}>
      <button
        className="icon-btn theme-trigger"
        title={`界面主题：${current.label}（点击切换）`}
        onClick={() => setOpen((v) => !v)}
      >
        {current.icon}
      </button>
      {open && (
        <div className="theme-menu">
          <div className="theme-menu-title">界面主题</div>
          {OPTIONS.map((o) => (
            <button
              key={o.value}
              className={`theme-option${o.value === settings.theme ? " active" : ""}`}
              onClick={() => {
                void update({ theme: o.value });
                setOpen(false);
              }}
            >
              <span className="theme-option-icon">{o.icon}</span>
              <span className="theme-option-text">
                <b>{o.label}</b>
                <small>{o.desc}</small>
              </span>
              {o.value === settings.theme && <span className="theme-tick">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
