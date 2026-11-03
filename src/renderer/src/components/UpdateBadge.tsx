import { useEffect, useRef, useState } from "react";
import type { UpdateStatus } from "@shared/types";
import { errorText } from "../errors";
import { useT } from "../settings";

export function UpdateBadge() {
  const t = useT();
  const [status, setStatus] = useState<UpdateStatus>();
  const [installError, setInstallError] = useState<string>();
  const [flash, setFlash] = useState<string>();
  const flashTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    void window.farm.updates.status().then(setStatus);
    return window.farm.updates.onStatus(setStatus);
  }, []);

  useEffect(() => () => window.clearTimeout(flashTimer.current), []);

  if (!status) return null;

  const hint =
    status.state === "checking"
      ? t("upd.checking")
      : status.state === "latest"
        ? (status.error ?? t("upd.latest"))
        : (status.error ?? t("upd.check"));
  const busy = status.state === "checking" || status.state === "downloading" || status.state === "ready";
  const version = status.latest ?? "";
  const install = () => {
    setInstallError(undefined);
    window.farm.updates.install().catch((e) => setInstallError(errorText(e)));
  };

  // 手动检查的结果只在顶部短暂显示，不弹对话框。
  const check = async (): Promise<void> => {
    setFlash(undefined);
    const result = await window.farm.updates.check();
    const text =
      result.state === "error"
        ? (result.error ?? t("upd.check"))
        : result.state === "latest"
          ? (result.error ?? t("upd.latest"))
          : undefined;
    if (!text) return;
    setFlash(text);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(undefined), 6000);
  };

  return (
    <div className="update">
      <button
        className={`version${status.state === "error" ? " failed" : ""}`}
        title={`${hint}\n${t("upd.clickToCheck")}`}
        disabled={busy}
        onClick={() => void check()}
      >
        v{status.current}
        {status.state === "checking" && "…"}
      </button>
      {flash && <span className="update-pill muted">{flash}</span>}
      {!flash && status.state === "available" && !status.canInstall && status.url && (
        <a className="update-pill" href={status.url} target="_blank" rel="noreferrer" title={status.error ?? t("upd.openRelease")}>
          {t("upd.available", { version })}
        </a>
      )}
      {!flash && status.state === "available" && status.canInstall && (
        <button className="update-pill" onClick={() => void window.farm.updates.download()} title={t("upd.updateHint")}>
          {t("upd.update", { version })}
        </button>
      )}
      {status.state === "downloading" && (
        <span className="update-pill muted">{t("upd.downloading", { percent: Math.round((status.progress ?? 0) * 100) })}</span>
      )}
      {status.state === "ready" && (
        <button className="update-pill ready" onClick={install} title={installError ?? t("upd.restartHint")}>
          {t("upd.restart", { version })}
        </button>
      )}
    </div>
  );
}
