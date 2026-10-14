import { Hash, QrCode, Radio, ShieldCheck, Sparkles } from "lucide-react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { PageHead } from "../../ui/common";

type HubCard = {
  id: string;
  to: string;
  title: string;
  desc: string;
  icon: typeof Sparkles;
};

export function ToolsHub() {
  const { t } = useTranslation();
  const cards: HubCard[] = [
    { id: "password", to: "/tools/password", title: t("home.toolPassword"), desc: t("home.toolPasswordDesc"), icon: Sparkles },
    { id: "crypto", to: "/tools/crypto", title: t("home.toolCrypto"), desc: t("home.toolCryptoDesc"), icon: Hash },
    { id: "qr", to: "/tools/qr", title: t("home.toolQr"), desc: t("home.toolQrDesc"), icon: QrCode },
    { id: "certs", to: "/tools/certs", title: t("tools.certsTitle"), desc: t("tools.certsDesc"), icon: ShieldCheck },
    { id: "filebeam", to: "/tools/filebeam", title: t("tools.fileBeamTitle"), desc: t("tools.fileBeamDesc"), icon: Radio },
  ];

  return (
    <div className="stack-lg tools-page">
      <PageHead title={t("nav.tools")} desc={t("tools.desc")} />
      <div className="tools-hub-grid">
        {cards.map((card) => {
          const Icon = card.icon;
          return (
            <Link key={card.to} to={card.to} className={`tools-hub-card tone-${card.id}`}>
              <span className="tools-pick-icon">
                <Icon size={18} />
              </span>
              <span className="tools-pick-title">{card.title}</span>
              <span className="tools-pick-desc">{card.desc}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
