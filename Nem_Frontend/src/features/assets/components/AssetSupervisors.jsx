import React, { useEffect, useState } from "react";
import { api } from "../../../services/api.js";

// Administrator-only: choose which Supervisors receive warning/alert emails for this asset.
export default function AssetSupervisors({ assetId }) {
  const [users, setUsers] = useState([]);
  const [selected, setSelected] = useState([]);
  const [inherited, setInherited] = useState([]);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    Promise.all([api.get("/auth/users"), api.get(`/assets/${assetId}/supervisors`)])
      .then(([allUsers, assignment]) => {
        if (!active) return;
        setUsers((allUsers || []).filter((u) => u.role === "Supervisor" && u.is_active));
        setSelected((assignment?.supervisors || []).map((s) => s.id));
        setInherited(assignment?.inherited_supervisors || []);
      })
      .catch((error) => active && setMessage(error.message));
    return () => { active = false; };
  }, [assetId]);

  const toggle = (id) =>
    setSelected((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));

  const save = async () => {
    setSaving(true);
    setMessage("");
    try {
      await api.put(`/assets/${assetId}/supervisors`, { user_ids: selected });
      setMessage("Saved");
    } catch (error) {
      setMessage(error.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <details className="muted" style={{ marginTop: 8 }}>
      <summary>
        Direct email supervisors ({selected.length})
        {inherited.length > 0 ? ` · ${inherited.length} inherited` : ""}
      </summary>
      <div style={{ display: "grid", gap: 6, padding: "8px 0" }}>
        {inherited.length > 0 && (
          <div aria-label="Inherited email notification supervisors">
            <strong>Inherited supervisors</strong>
            {inherited.map((u) => (
              <div key={u.id}>
                {u.username} {u.email_address ? `(${u.email_address})` : "(no email address)"} — Inherited from{" "}
                {u.inherited_from.map((source) => source.asset_name).join(", ")}
              </div>
            ))}
          </div>
        )}
        {users.length === 0 && <span>No active supervisors available.</span>}
        {users.map((u) => (
          <label key={u.id}>
            <input type="checkbox" checked={selected.includes(u.id)} onChange={() => toggle(u.id)} />{" "}
            {u.username} {u.email_address ? `(${u.email_address})` : "(no email address)"}
          </label>
        ))}
        <div>
          <button type="button" className="link-btn" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save supervisors"}
          </button>{" "}
          {message && <span role="status">{message}</span>}
        </div>
      </div>
    </details>
  );
}
