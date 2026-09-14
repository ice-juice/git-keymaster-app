import { useTranslation } from "react-i18next";
import { Card } from "./common";
import { useLocale } from "../lib/locale";
import type { UiLocale } from "../lib/i18n";

const OPTIONS: UiLocale[] = ["system", "zh", "en"];

export function LanguageCard() {
  const { t } = useTranslation();
  const { uiLocale, setUiLocale } = useLocale();

  return (
    <Card title={t("settings.language.title")}>
      <div className="stack">
        <div className="choice-row">
          {OPTIONS.map((id) => (
            <button
              key={id}
              type="button"
              className={"choice" + (uiLocale === id ? " on" : "")}
              onClick={() => void setUiLocale(id)}
            >
              {t(`settings.language.${id}`)}
            </button>
          ))}
        </div>
        <div className="hint">{t("settings.language.hint")}</div>
      </div>
    </Card>
  );
}

export function LanguageChoiceRow() {
  const { t } = useTranslation();
  const { uiLocale, setUiLocale } = useLocale();

  return (
    <div className="stack">
      <div className="choice-row">
        {OPTIONS.map((id) => (
          <button
            key={id}
            type="button"
            className={"choice" + (uiLocale === id ? " on" : "")}
            style={{ flex: "1 1 100%", padding: "12px 14px" }}
            onClick={() => void setUiLocale(id)}
          >
            <strong>{t(`settings.language.${id}`)}</strong>
          </button>
        ))}
      </div>
      <div className="hint">{t("settings.language.hint")}</div>
    </div>
  );
}
