import { Route, Routes } from "react-router-dom";
import { ToolsHub } from "./ToolsHub";
import { ToolsPasswordPage } from "./ToolsPasswordPage";
import { ToolsCryptoPage } from "./ToolsCryptoPage";
import { ToolsQrPage } from "./ToolsQrPage";
import { ToolsCertsPage } from "./ToolsCertsPage";
import { ToolsFileBeamPage } from "./ToolsFileBeamPage";

export function ToolsRoutes() {
  return (
    <Routes>
      <Route index element={<ToolsHub />} />
      <Route path="password" element={<ToolsPasswordPage />} />
      <Route path="crypto" element={<ToolsCryptoPage />} />
      <Route path="qr" element={<ToolsQrPage />} />
      <Route path="certs" element={<ToolsCertsPage />} />
      <Route path="filebeam" element={<ToolsFileBeamPage />} />
    </Routes>
  );
}
