import { useEffect, useRef, useState } from "react";
import { api } from "../api";
type Settings = {
  delaySeconds: number;
  typingEnabled?: boolean;
  revision: number;
  maxDelaySeconds: number;
};
const valid = (s: Settings) =>
  s &&
  Number.isSafeInteger(s.delaySeconds) &&
  s.delaySeconds >= 0 &&
  s.delaySeconds <= 300 &&
  Number.isSafeInteger(s.revision) && (s.typingEnabled === undefined || typeof s.typingEnabled === 'boolean');
export default function WhatsAppResponseSettings({
  businessId,
  canManage,
  typingAvailable = false,
}: {
  businessId: number;
  canManage: boolean;
  typingAvailable?: boolean;
}) {
  const [settings, setSettings] = useState<Settings | null>(null),
    [delay, setDelay] = useState(0),
    [typing, setTyping] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const controller = useRef(new AbortController()),
    pending = useRef(false);
  const path = `/businesses/${businessId}/whatsapp/response-settings`;
  async function read(replace: boolean) {
    const { data } = await api.get(path, {
      signal: controller.current.signal,
      timeout: 15000,
    });
    if (controller.current.signal.aborted) return;
    if (!data.success || !valid(data.settings)) throw new Error();
    setSettings(data.settings);
    if (replace) { setDelay(data.settings.delaySeconds); setTyping(data.settings.typingEnabled === true); }
    return data.settings as Settings;
  }
  useEffect(() => {
    const c = new AbortController();
    controller.current = c;
    void read(true).catch(() => {
      if (!c.signal.aborted) setError("Не удалось загрузить время ответа.");
    });
    return () => c.abort();
  }, [businessId]);
  async function save() {
    if (
      !canManage ||
      !settings ||
      pending.current ||
      !Number.isInteger(delay) ||
      delay < 0 ||
      delay > 300
    )
      return;
    pending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { data } = await api.put(
        path,
        { delaySeconds: delay, revision: settings.revision, ...(typingAvailable ? { typingEnabled: typing } : {}) },
        { signal: controller.current.signal, timeout: 15000 },
      );
      if (controller.current.signal.aborted) return;
      if (!data.success || !valid(data.settings)) throw new Error();
      const after = await read(false);
      if (
        after?.delaySeconds !== delay || (typingAvailable && (after?.typingEnabled === true) !== typing) ||
        after.revision !== data.settings.revision
      )
        throw new Error();
      setNotice(
        delay
          ? "Время ожидания сохранено. Новые сообщения дополнят контекст перед ответом."
          : "Сохранено. AVA отвечает без дополнительной задержки.",
      );
    } catch (e) {
      if (!controller.current.signal.aborted) {
        const conflict =
          (e as { response?: { status: number } })?.response?.status === 409;
        setError(
          conflict
            ? "Настройку уже изменили. Ваш выбор сохранён. Сначала обновите сохранённые данные."
            : "Сохранение не подтверждено. Проверьте настройку и повторите попытку.",
        );
      }
    } finally {
      pending.current = false;
      if (!controller.current.signal.aborted) setBusy(false);
    }
  }
  return (
    <section
      className="mt-6 space-y-3 border-t border-[var(--neu-border)] pt-5"
      aria-label="Время ответа WhatsApp"
    >
      <h3 className="font-semibold">Когда отвечать</h3>
      <p className="ava-channel-hint">
        Сразу или после небольшой паузы, чтобы клиент успел дописать. Переданный
        менеджеру диалог AVA не продолжает самостоятельно.
      </p>
      {settings && (
        <>
          <label className="block">
            <span>Пауза перед ответом</span>
            <select
              className="input mt-2"
              aria-label="Пауза перед ответом WhatsApp"
              value={delay === 0 ? "immediate" : "delay"}
              disabled={!canManage || busy}
              onChange={(e) =>
                setDelay(
                  e.target.value === "immediate" ? 0 : Math.max(5, delay),
                )
              }
            >
              <option value="immediate">Сразу</option>
              <option value="delay">Подождать сообщения клиента</option>
            </select>
          </label>
          {delay > 0 && (
            <label className="block">
              Секунд ожидания
              <input
                className="input mt-2"
                type="number"
                min={1}
                max={300}
                step={1}
                value={delay}
                disabled={!canManage || busy}
                onChange={(e) => setDelay(Number(e.target.value))}
              />
            </label>
          )}
          {typingAvailable && <label className="flex items-start gap-3">
            <input type="checkbox" className="mt-1" checked={typing} disabled={!canManage || busy} onChange={event => setTyping(event.target.checked)} />
            <span>Показывать «печатает», пока помощник готовит ответ</span>
          </label>}
          {typingAvailable && <p className="ava-channel-hint">Показывается во время подготовки ответа WhatsApp. Если диалог взял менеджер, помощник не показывает этот статус.</p>}
          {canManage && (
            <button
              type="button"
              className="btn-secondary"
              disabled={
                busy || !Number.isInteger(delay) || delay < 0 || delay > 300
              }
              onClick={() => void save()}
            >
              {busy ? "Сохраняем…" : "Сохранить время ответа"}
            </button>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="ava-whatsapp-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <button
          type="button"
          className="btn-secondary"
          disabled={busy}
          onClick={() => {
            setError("");
            void read(false)
              .then(() =>
                setNotice(
                  "Сохранённая настройка обновлена. Ваш выбор оставлен для сравнения.",
                ),
              )
              .catch(() => setError("Не удалось обновить настройку."));
          }}
        >
          Обновить сохранённую настройку
        </button>
      )}
    </section>
  );
}
