
import React, { useState } from "react";
import { api } from "../../../services/api.js";
import { useAuth } from "../../auth/AuthContext.jsx";

export default function ExportConfigurationPage() {
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const canExport = [
    "Administrator",
    "Supervisor",
  ].includes(user?.role);

  const exportConfiguration = async () => {
    if (!canExport || busy) return;

    setBusy(true);
    setError("");

    try {
      const [rules, collections] = await Promise.all([
        api.getAll("/rules"),
        api.getAll("/collections"),
      ]);

      const data = {
        rules,
        collections,
      };

      const blob = new Blob(
        [JSON.stringify(data, null, 2)],
        { type: "application/json" }
      );

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");

      link.href = url;
      link.download = "nem-configuration-export.json";
      document.body.appendChild(link);
      link.click();
      link.remove();

      URL.revokeObjectURL(url);
    } catch (err) {
      setError(
        err.message || "Configuration export failed."
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <button
        type="button"
        className="link-btn"
        onClick={() => window.history.back()}
      >
        ← Back
      </button>

      <h1 className="page-title">
        Export configuration
      </h1>

      <div className="panel">
        <p>
          Export monitoring rules and rule collections
          as a JSON file.
        </p>

        {!canExport && (
          <p className="notice" role="status">
            Only Administrators and Supervisors can export
            configuration.
          </p>
        )}

        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}

        <button
          type="button"
          className="btn-primary"
          disabled={!canExport || busy}
          onClick={exportConfiguration}
        >
          {busy ? "Exporting..." : "Export JSON"}
        </button>
      </div>
    </div>
  );
}
