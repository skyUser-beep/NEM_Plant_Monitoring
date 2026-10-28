import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../../../services/api.js";
import { formatTime } from "../../../utils/format.js";
import { useAuth } from "../../auth/AuthContext.jsx";
import {
  CreateModal,
  EmptyState,
  useConfirmation,
} from "../../../components/common/UI.jsx";
import { BackIcon, EditIcon } from "../../../components/common/Icons.jsx";

const TITLES = {
  user: "User information",
  email: "Email server settings",
  analytics: "Analytics extensions",
  connectivity: "Connectivity configuration",
  usage: "Usage information",
  backup: "Backup and restore",
};

const FORMS = {
  email: [["host", "SMTP host"], ["port", "Port", "number"], ["username", "Username"], ["password", "Password", "password"], ["sender", "Sender address"]],
  analytics: [["databus_host", "Databus host"], ["databus_port", "Databus port"], ["enabled", "Enabled", "bool"]],
  connectivity: [["databus_host", "IE Databus address"], ["username", "Username"], ["password", "Password", "password"], ["discovery_topic", "Discovery topic"], ["enabled", "Enabled", "bool"]],
};


function UserInfo() {
  const { user, refreshUser } = useAuth();
  const [err, setErr] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [editContact, setEditContact] = useState(user?.contact_number || "");
  const [editEmail, setEditEmail] = useState(user?.email_address || "");
  const [contactError, setContactError] = useState("");
  const [emailError, setEmailError] = useState("");
  const [saveMsg, setSaveMsg] = useState("");
  const canEdit = user?.role === "Administrator";
  useEffect(() => {
    let active = true;
    refreshUser().catch((e) => {
      if (active) setErr(String(e.message || e));
    });
    return () => { active = false; };
  }, [refreshUser]);
  if (err) return <div className="panel"><p className="notice error flush" role="alert">Could not load the profile: {err}</p></div>;
  if (!user) return <div className="loading">Loading…</div>;

  const displayName = user.username || "—";
  const role = user.role || "—";

  const INDIAN_PHONE_REGEX = /^(\+91|91|0)?[6-9]\d{9}$/;
  const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const normalizePhone = (value) => {
    const digits = value.replace(/\D/g, "");
    if (digits.startsWith("91") && digits.length === 12) return digits.slice(2);
    if (digits.startsWith("0") && digits.length === 11) return digits.slice(1);
    return digits;
  };

  const validatePhone = (value) => {
    const trimmed = value.trim();
    if (!trimmed) return { valid: true, normalized: "" };
    const digits = trimmed.replace(/\D/g, "");
    if (!INDIAN_PHONE_REGEX.test(trimmed)) return { valid: false, normalized: "" };
    return { valid: true, normalized: normalizePhone(trimmed) };
  };

  const validateEmail = (value) => {
    const trimmed = value.trim();
    if (!trimmed) return { valid: true, normalized: "" };
    if (!EMAIL_REGEX.test(trimmed)) return { valid: false, normalized: "" };
    return { valid: true, normalized: trimmed };
  };

  const saveContact = async () => {
    setSaveMsg("");
    setContactError("");
    setEmailError("");
    const contactResult = validatePhone(editContact);
    if (!contactResult.valid) {
      setContactError("Enter a valid Indian mobile number (10 digits, optionally prefixed with +91).");
      return;
    }
    const emailResult = validateEmail(editEmail);
    if (!emailResult.valid) {
      setEmailError("Enter a valid email address (e.g., name@domain.com).");
      return;
    }
    try {
      await api.patch(`/auth/users/${user.id}`, {
        contact_number: contactResult.normalized || null,
        email_address: emailResult.normalized || null,
      });
      await refreshUser();
      setEditContact(user?.contact_number || "");
      setEditEmail(user?.email_address || "");
      setIsEditing(false);
      setSaveMsg("Contact details saved.");
    } catch (e) {
      setSaveMsg("Could not save contact details: " + (e.message || e));
    }
  };

  return (
    <div className="panel-white profile">
      <div className="profile-head" style={{ position: "relative", display: "flex", alignItems: "center", gap: 12 }}>
        <div className="avatar">{displayName.charAt(0).toUpperCase()}</div>
        <div className="profile-who">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div className="profile-name">{displayName}</div>
          </div>
          <span className="badge role">{role}</span>
        </div>
        {canEdit && (
          <button
            type="button"
            onClick={() => {
              setEditContact(user?.contact_number || "");
              setEditEmail(user?.email_address || "");
              setIsEditing(true);
            }}
            title="Edit contact details"
            className="btn-outline"
            style={{
              position: "absolute",
              right: 12,
              top: "50%",
              transform: "translateY(-50%)",
              height: "32px",
              padding: "0 10px",
              fontSize: "13px",
              borderRadius: "4px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <EditIcon size={14} aria-hidden="true" />
          </button>
        )}
      </div>

    <dl className="profile-list">
  <dt>Name</dt>
  <dd>{displayName}</dd>

  <dt>Role</dt>
  <dd>{role}</dd>

  <dt>Account status</dt>
  <dd>{user.is_active ? "Active" : "Disabled"}</dd>

  <dt>Contact number</dt>
  <dd>
    {isEditing ? (
      <>
        <input
          type="tel"
          value={editContact}
          onChange={(e) => setEditContact(e.target.value)}
          placeholder="Enter contact number"
          autoComplete="tel"
          maxLength={20}
        />
        {contactError && <span className="notice error" style={{ display: "block", marginTop: 4, fontSize: "12px" }}>{contactError}</span>}
      </>
    ) : (
      user?.contact_number || "Not provided"
    )}
  </dd>

  <dt>Email address</dt>
  <dd>
    {isEditing ? (
      <>
        <input
          type="email"
          value={editEmail}
          onChange={(e) => setEditEmail(e.target.value)}
          placeholder="Enter email address"
          autoComplete="email"
          maxLength={254}
        />
        {emailError && <span className="notice error" style={{ display: "block", marginTop: 4, fontSize: "12px" }}>{emailError}</span>}
      </>
    ) : (
      user?.email_address || "Not provided"
    )}
  </dd>
</dl>

{isEditing && canEdit ? (
  <div style={{ marginTop: 12, display: "flex", gap: 10, alignItems: "center" }}>
    <button
      type="button"
      className="btn-primary"
      onClick={saveContact}
      disabled={!editContact.trim() && !editEmail.trim()}
    >
      Save
    </button>
    <button type="button" className="btn-outline" onClick={() => setIsEditing(false)}>
      Cancel
    </button>
    {saveMsg && <span className="notice" role="status" style={{ marginLeft: 10 }}>{saveMsg}</span>}
  </div>
) : null}

<p className="hint">
  Your name and role are taken from your signed-in account.
  An Administrator can update your role.
</p>
    </div>
  );
}

function SettingsForm({ section }) {
  const { user } = useAuth();
  const canManageSettings = user?.role === "Administrator";
  const [v, setV] = useState(null);
  const [msg, setMsg] = useState("");
  const [testRecipient, setTestRecipient] = useState("");
  const [testMsg, setTestMsg] = useState("");
  const [sendingTest, setSendingTest] = useState(false);
  useEffect(() => {
    setMsg(""); setV(null);
    if (!canManageSettings) {
      setV({});
      return;
    }
    api.get(`/settings/${section}`).then(setV).catch((error) => setMsg(`Could not load settings: ${error.message}`));
  }, [canManageSettings, section]);
  if (!v) return msg ? <div className="notice error">{msg}</div> : <div className="loading">LoadingÃ¢â‚¬Â¦</div>;
  const save = async () => {
    if (!canManageSettings) return;
    setTestMsg("");
    try {
      const saved = await api.put(`/settings/${section}`, v);
      setV(saved);
      setMsg("Settings saved.");
    } catch (error) {
      setMsg(`Could not save settings: ${error.message}`);
    }
  };
  const sendTestEmail = async () => {
    if (!canManageSettings || sendingTest) return;
    setSendingTest(true);
    setTestMsg("");
    try {
      const result = await api.post("/notifications/email/test", {
        recipient: testRecipient.trim(),
      });
      setTestMsg(result.message);
    } catch (error) {
      setTestMsg(`Could not send test email: ${error.message}`);
    } finally {
      setSendingTest(false);
    }
  };
  return (
    <div className="panel-white form">
      {!canManageSettings && (
        <p className="notice" role="status">
          Global settings are read-only. You do not have permission to change them.
        </p>
      )}
      {(section === "email" || section === "connectivity") && <p className="hint">{v.has_password
        ? "A password is stored encrypted. Leave the password field empty to keep it, or enter a replacement."
        : "The password is encrypted before it is saved."}</p>}
      {FORMS[section].map(([k, label, type]) => (
        <label key={k}>{label}
          {type === "bool" ? (
            <select disabled={!canManageSettings} value={String(v[k] ?? "false")} onChange={(e) => setV({ ...v, [k]: e.target.value })}>
              <option value="true">Enabled</option>
              <option value="false">Disabled</option>
            </select>
          ) : (
            <input disabled={!canManageSettings} type={type || "text"} autoComplete={type === "password" ? "new-password" : undefined}
              value={v[k] || ""} onChange={(e) => setV({ ...v, [k]: e.target.value })} />
          )}
        </label>
      ))}
      <div><button className="btn-primary" disabled={!canManageSettings} title={!canManageSettings ? "Only Administrators can change global settings." : undefined} onClick={save}>Save</button></div>
      {msg && <p className={"notice" + (/^Could not/.test(msg) ? " error" : "")} role="status">{msg}</p>}
      {section === "email" && canManageSettings && (
        <div className="form" style={{ marginTop: 20 }}>
          <label>
            Test recipient email
            <input
              type="email"
              maxLength={254}
              autoComplete="email"
              value={testRecipient}
              onChange={(event) => {
                setTestRecipient(event.target.value);
                setTestMsg("");
              }}
              placeholder="recipient@example.com"
            />
          </label>
          <p className="hint">
            Save the SMTP settings first. The test uses the saved sender
            sky@nem.co.in and does not create an alert. SMTP acceptance does
            not confirm inbox receipt.
          </p>
          <div>
            <button
              type="button"
              className="btn-outline"
              disabled={sendingTest || !testRecipient.trim()}
              onClick={sendTestEmail}
            >
              {sendingTest ? "Sending test…" : "Send test email"}
            </button>
          </div>
          {testMsg && (
            <p
              className={"notice" + (/^Could not/.test(testMsg) ? " error" : "")}
              role="status"
            >
              {testMsg}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Usage() {
  const [u, setU] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => { api.get("/usage").then(setU).catch((e) => setError(e.message)); }, []);
  if (error) return <div className="notice error">Could not load usage: {error}</div>;
  if (!u) return <div className="loading">LoadingÃ¢â‚¬Â¦</div>;
  return (
    <div className="usage-grid">
      {Object.entries(u).map(([k, v]) => (
        <div key={k} className="stat-card"><div className="stat-sub">{k.replaceAll("_", " ")}</div><div className="stat-val">{v}</div></div>
      ))}
    </div>
  );
}

function Backup() {
  const { user } = useAuth();
  const canManageBackups = user?.role === "Administrator";
  const confirm = useConfirmation();
  const [list, setList] = useState([]);
  const [msg, setMsg] = useState("");
  const [open, setOpen] = useState(false);
  const load = () => api.get("/backups").then(setList).catch((error) => setMsg(`Could not load backups: ${error.message}`));
  useEffect(() => { if (canManageBackups) load(); }, [canManageBackups]);
  const create = async (values) => {
    if (!canManageBackups) return;
    const b = await api.post("/backups", values);
    setOpen(false); setMsg(`Backup ${b.name} created.`); load();
  };
  const restore = async (b) => {
    if (!canManageBackups) return;
    if (
      !(await confirm(
        `Restore "${b.name}"? This replaces all current monitoring data.`,
        {
          title: "Restore backup",
          confirmLabel: "Restore backup",
          destructive: true,
        }
      ))
    ) return;
    try {
      await api.post(`/backups/${b.id}/restore`);
      setMsg(`Backup ${b.name} restored.`);
    } catch (error) {
      setMsg(`Could not restore backup: ${error.message}`);
    }
  };
  return (
    <>
      <div className="panel-white">
        {!canManageBackups && <p className="notice" role="status">Backup and restore are restricted to Administrators.</p>}
        <button className="btn-primary" disabled={!canManageBackups} title={!canManageBackups ? "Only Administrators can create backups." : undefined} onClick={() => setOpen(true)}>Create backup</button>
        {msg && <p className={"notice" + (/^Could not/.test(msg) ? " error" : "")} role="status">{msg}</p>}
      </div>
      {open && (
        <CreateModal
          title="Create backup" submitLabel="Create backup" onSubmit={create} onClose={() => setOpen(false)}
          disabled={!canManageBackups}
          fields={[
            { key: "name", label: "Backup name", placeholder: "Leave empty for an automatic name" },
            { key: "note", label: "Note", type: "textarea", placeholder: "Why are you taking this backup?" },
          ]}
        />
      )}
      <div className="panel-white">
        {!canManageBackups ? (
          <p className="muted">Backup records are available to Administrators only.</p>
        ) : list.length === 0 ? <EmptyState title="No backups yet" /> :
          <table className="table"><thead><tr><th>Name</th><th>Created</th><th /></tr></thead>
            <tbody>{list.map((b) => (
              <tr key={b.id}><td>{b.name}</td><td>{formatTime(b.created)}</td>
                <td className="right"><button className="btn-outline" disabled={!canManageBackups} title={!canManageBackups ? "Only Administrators can restore backups." : undefined} onClick={() => restore(b)}>Restore</button></td></tr>))}</tbody></table>}
      </div>
    </>
  );
}

export default function SettingsSub() {
  const { sub } = useParams();
  const nav = useNavigate();
  return (
    <div>
      <button className="link-btn" onClick={() => nav("/settings")}><BackIcon size={14} /> Back</button>
      <h1>{TITLES[sub] || "Settings"}</h1>
      {sub === "user" && <UserInfo />}
      {(sub === "email" || sub === "analytics" || sub === "connectivity") && <SettingsForm section={sub} />}
      {sub === "usage" && <Usage />}
      {sub === "backup" && <Backup />}
    </div>
  );
}