
import React from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";

import Layout from "../components/common/Layout.jsx";

import Home from "../features/dashboard/pages/Home.jsx";

import AlertRules from "../features/rules/pages/AlertRules.jsx";
import RuleCreatePage from "../features/rules/pages/RuleCreatePage.jsx";

import AssetsIndex from "../features/assets/pages/AssetsIndex.jsx";
import AssetDetail from "../features/assets/pages/AssetDetail.jsx";

import Configuration from "../features/configuration/pages/Configuration.jsx";
import ConfigSub from "../features/configuration/pages/ConfigSub.jsx";
import DocumentCreatePage from "../features/configuration/pages/DocumentCreatePage.jsx";
import CreateInstructionPage from "../features/configuration/pages/CreateInstructionPage.jsx";
import DocumentViewerPage from "../features/configuration/pages/DocumentViewerPage.jsx";
import RuleLibrary from "../features/configuration/pages/RuleLibrary.jsx";

import Plc from "../features/plc/pages/Plc.jsx";

import Settings from "../features/settings/pages/Settings.jsx";
import SettingsSub from "../features/settings/pages/SettingsSub.jsx";
import CreateMaintenanceSchedulePage from "../features/assets/pages/CreateMaintenanceSchedulePage.jsx";
import CreateMonitoringRulePage from "../features/assets/pages/CreateMonitoringRulePage.jsx";
import LoginPage from "../features/auth/LoginPage.jsx";
import AdminUsersPage from "../features/auth/AdminUsersPage.jsx";
import { useAuth } from "../features/auth/AuthContext.jsx";
import { ConfirmationProvider } from "../components/common/UI.jsx";
import ExportConfigurationPage from "../features/configuration/pages/ExportConfigurationPage.jsx";

export default function App() {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return <main className="auth-page"><p role="status">Checking session…</p></main>;
  }

  return (
    <ConfirmationProvider>
    <Routes>
      <Route
        path="/login"
        element={user ? <Navigate to="/" replace /> : <LoginPage />}
      />
      <Route
        element={
          user
            ? <Layout />
            : <Navigate to="/login" replace state={{ from: location }} />
        }
      >
        {/* Dashboard */}
        <Route path="/" element={<Home />} />

        {/* Alert Rules */}
        <Route path="/rules/:kind" element={<AlertRules />} />

        {/* Assets */}
        <Route path="/assets" element={<AssetsIndex />} />
        <Route path="/assets/:id" element={<AssetDetail />} />
        <Route
          path="/assets/:id/rules/new/:kind"
          element={<RuleCreatePage />}
        />

        {/* Configuration */}
        <Route path="/configuration" element={<Configuration />} />
        <Route
          path="/configuration/rules"
          element={<RuleLibrary />}
        />
        <Route
          path="/configuration/documents/new"
          element={<DocumentCreatePage />}
        />
        <Route
          path="/configuration/instructions/new"
          element={<CreateInstructionPage />}
        />
        <Route
          path="/configuration/instructions"
          element={<Navigate to="/configuration/documents" replace />}
        />
        <Route
          path="/configuration/documents/:documentId/files/:fileId/view"
          element={<DocumentViewerPage />}
        />

        {/* Other configuration sections */}
        <Route
          path="/configuration/:sub"
          element={<ConfigSub />}
        />

        {/* Settings */}
        <Route path="/settings" element={<Settings />} />
        <Route
          path="/settings/users"
          element={<AdminUsersPage />}
        />
        <Route
          path="/settings/:sub"
          element={<SettingsSub />}
        />

        {/* PLC */}
        <Route path="/plc" element={<Plc />} />

        {/* Maintenance */}

{/* Maintenance */}
<Route
  path="/assets/:id/maintenance/schedules/new"
  element={<CreateMaintenanceSchedulePage />}
/>

<Route
  path="/assets/:id/maintenance/schedules/:scheduleId/edit"
  element={<CreateMaintenanceSchedulePage />}
/>

{/* Monitoring Rules */}
<Route
  path="/assets/:id/monitoring-rules/new/:choiceId"
  element={<CreateMonitoringRulePage />}
/>

{/* Monitoring Rules */}
<Route
  path="/assets/:id/monitoring-rules/new/:choiceId"
  element={<CreateMonitoringRulePage />}
/>

{/* Edit existing monitoring rule */}
<Route
  path="/assets/:id/monitoring-rules/:rule_type/edit"
  element={<CreateMonitoringRulePage />}
/>

<Route
  path="/configuration/export"
  element={<ExportConfigurationPage />}
/>

{/* Fallback — keep this last */}
<Route path="*" element={<Home />} />
      </Route>
    </Routes>
    </ConfirmationProvider>
  );
}
