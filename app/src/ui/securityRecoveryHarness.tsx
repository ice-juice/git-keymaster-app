// Imported only by scripts/test-security-recovery-ui.cjs on its isolated test page.
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import "../lib/i18n";
import { useApp } from "../store";
import { RecoveryKeyRotation } from "./RecoveryKeyRotation";
import type { VaultStatus } from "../lib/ipc";

const synthetic: VaultStatus = {
  initialized: true, unlocked: true, workspaceId: "synthetic-vault", workspacePath: "synthetic-path",
  autoLockMinutes: 15, launchAtLogin: false, graceDays: 0,
  graceActive: false, graceExpiresAt: null, closeAction: null,
};
useApp.setState({ loading: false, status: synthetic });
(window as unknown as { __securityStore: typeof useApp }).__securityStore = useApp;
createRoot(document.getElementById("root")!).render(createElement(RecoveryKeyRotation));
