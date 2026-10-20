import React, { useEffect, useState } from "react";
import {
  useNavigate,
  useOutletContext,
  useParams,
} from "react-router-dom";
import { api } from "../../../services/api.js";
import "./RuleCreatePage.css";

const titles = {
  interval: "Create interval-based maintenance",
  usage: "Create usage-based rule",
  time: "Create time-based maintenance",
};

function todayDateInput() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

const initialValues = {
  name: "",
  description: "",
  variable_id: "",
  usage_limit: "",
  severity: "warning",
  schedule_start_date: todayDateInput(),
  first_due_date: "",
  recurrence_enabled: true,
  recurrence_interval: "1",
  recurrence_unit: "months",
  planned_start_at: "",
  planned_end_at: "",
};

export default function RuleCreatePage() {
  const { id, kind } = useParams();
  const navigate = useNavigate();
  const { assets = [], refreshStatus } = useOutletContext() || {};
  const assetId = Number(id);
  const asset = assets.find((item) => Number(item.id) === assetId);

  const [variables, setVariables] = useState([]);
  const [values, setValues] = useState({ ...initialValues });
  const [loading, setLoading] = useState(kind === "usage");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (kind !== "usage") return undefined;
    let active = true;
    api.getAll(`/assets/${assetId}/variables?is_active=true`)
      .then((items) => {
        if (!active) return;
        const numeric = (Array.isArray(items) ? items : [])
          .filter((item) => ["number", "integer"].includes(item.data_type));
        setVariables(numeric);
        if (numeric.length) {
          setValues((current) => ({ ...current, variable_id: String(numeric[0].id) }));
        }
      })
      .catch((requestError) => {
        if (active) setError(requestError.message || "Could not load usage metrics.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [assetId, kind]);

  const goBack = () => navigate(`/assets/${id}`);
  const updateField = (event) => {
    const { name, value, type, checked } = event.target;
    setValues((current) => ({
      ...current,
      [name]: type === "checkbox" ? checked : value,
    }));
    setError("");
  };

  const completeCreation = async (message) => {
    let notice = message;
    try {
      await refreshStatus?.();
    } catch {
      notice += " The dashboard summary could not be refreshed; the saved item is available on the asset.";
    }
    navigate(`/assets/${id}`, {
      replace: true,
      state: { createdNotice: notice },
    });
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (saving) return;
    setError("");
    if (!values.name.trim()) {
      setError("Please enter a name.");
      return;
    }

    setSaving(true);
    try {
      const name = values.name.trim();
      const description = values.description.trim();
      if (kind === "interval") {
        if (!values.schedule_start_date || !values.first_due_date) {
          throw new Error("Enter both the schedule start date and first due date.");
        }
        if (values.first_due_date < values.schedule_start_date) {
          throw new Error("The first due date must not precede the schedule start date.");
        }
        let recurrenceInterval = null;
        let recurrenceUnit = null;
        if (values.recurrence_enabled) {
          recurrenceInterval = Number(values.recurrence_interval);
          recurrenceUnit = values.recurrence_unit;
          if (!Number.isInteger(recurrenceInterval) || recurrenceInterval < 1 || recurrenceInterval > 3650) {
            throw new Error("Recurrence interval must be a whole number from 1 to 3650.");
          }
        }
        await api.post("/maintenance/schedules", {
          asset_id: assetId,
          title: name,
          description: description || null,
          maintenance_type: "preventive",
          priority: "medium",
          schedule_start_date: values.schedule_start_date,
          first_due_date: values.first_due_date,
          recurrence_enabled: values.recurrence_enabled,
          recurrence_interval: recurrenceInterval,
          recurrence_unit: recurrenceUnit,
        });
        await completeCreation("Recurring maintenance schedule created. View due dates in the asset maintenance logbook.");
      } else if (kind === "usage") {
        const usageLimit = Number(values.usage_limit);
        if (!values.variable_id || !variables.some((item) => String(item.id) === values.variable_id)) {
          throw new Error("Select an active numeric usage metric.");
        }
        if (!Number.isFinite(usageLimit) || usageLimit <= 0) {
          throw new Error("Enter a valid positive usage threshold.");
        }
        await api.post(`/assets/${assetId}/rules/usage`, {
          name,
          description: description || null,
          variable_id: Number(values.variable_id),
          usage_limit: usageLimit,
          severity: values.severity,
        });
        await completeCreation("Usage threshold rule created and activated.");
      } else if (kind === "time") {
        if (!description) {
          throw new Error("Describe the maintenance work to be performed.");
        }
        if (!values.planned_start_at || !values.planned_end_at) {
          throw new Error("Select both a planned start and end date/time.");
        }
        const start = new Date(values.planned_start_at);
        const end = new Date(values.planned_end_at);
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
          throw new Error("Enter valid planned dates and times.");
        }
        if (end < start) {
          throw new Error("The planned end date/time must not precede the start.");
        }
        await api.post("/maintenance", {
          asset_id: assetId,
          title: name,
          notes: description,
          maintenance_type: "preventive",
          status: "planned",
          priority: "medium",
          planned_start_at: start.toISOString(),
          planned_end_at: end.toISOString(),
        });
        await completeCreation("Planned time-based maintenance created. View it in the asset maintenance logbook.");
      } else {
        throw new Error("Unknown workflow type.");
      }
    } catch (requestError) {
      setError(requestError.message || "Could not create the selected item.");
    } finally {
      setSaving(false);
    }
  };

  if (!titles[kind]) {
    return (
      <section className="panel">
        <p>Unknown rule type.</p>
        <button type="button" className="btn-outline rule-back-btn" onClick={goBack}>
          Back to asset
        </button>
      </section>
    );
  }

  if (loading) {
    return <div className="loading" role="status">Loading numeric usage metrics…</div>;
  }

  const recurrenceEnabled = kind === "interval" && values.recurrence_enabled;
  const buttonLabel = kind === "interval"
    ? "Create schedule"
    : kind === "time"
      ? "Schedule maintenance"
      : "Create usage rule";

  return (
    <div className="rule-create-page">
      <div className="rule-create-container">
        <button type="button" className="btn-outline rule-back-btn" onClick={goBack}>
          ← Back to {asset?.name || "asset"}
        </button>

        <div className="page-head rule-page-head" style={{ marginTop: 20 }}>
          <h1 className="page-title rule-page-title">{titles[kind]}</h1>
          <p className="muted rule-page-subtitle">Asset: {asset?.name || `#${assetId}`}</p>
        </div>

        <section className="rule-create-card">
          <div className="rule-create-card-header">
            <h2>{titles[kind]}</h2>
            <p>
              {kind === "usage"
                ? "The selected numeric reading is evaluated by the monitoring engine."
                : kind === "interval"
                  ? "This uses recurring maintenance scheduling, due dates, and the existing overdue service."
                  : "This creates a planned maintenance job with a scheduled start and end."}
            </p>
          </div>

          <div className="rule-create-form">
            {error && <p role="alert" className="error-message">{error}</p>}
            <form onSubmit={handleSubmit}>
              <div className="form-group">
                <label htmlFor="rule-name">{kind === "usage" ? "Rule name *" : "Schedule name *"}</label>
                <input
                  id="rule-name"
                  name="name"
                  value={values.name}
                  onChange={updateField}
                  placeholder={kind === "usage" ? "e.g. Rotation count limit" : "e.g. Motor service"}
                  required
                  disabled={saving}
                />
              </div>

              <div className="form-group">
                <label htmlFor="rule-description">
                  {kind === "time" ? "Work description *" : "Description"}
                </label>
                <textarea
                  id="rule-description"
                  name="description"
                  value={values.description}
                  onChange={updateField}
                  rows={3}
                  required={kind === "time"}
                  disabled={saving}
                />
              </div>

              {kind === "interval" && (
                <>
                  <div className="form-group">
                    <label htmlFor="schedule-start-date">Schedule start date *</label>
                    <input
                      id="schedule-start-date"
                      name="schedule_start_date"
                      type="date"
                      value={values.schedule_start_date}
                      onChange={updateField}
                      required
                      disabled={saving}
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="first-due-date">First due date *</label>
                    <input
                      id="first-due-date"
                      name="first_due_date"
                      type="date"
                      value={values.first_due_date}
                      onChange={updateField}
                      min={values.schedule_start_date}
                      required
                      disabled={saving}
                    />
                  </div>
                  <label className="form-group rule-checkbox-field">
                    <input
                      name="recurrence_enabled"
                      type="checkbox"
                      checked={values.recurrence_enabled}
                      onChange={updateField}
                      disabled={saving}
                    />
                    Repeat after each completed maintenance
                  </label>
                  {recurrenceEnabled && (
                    <>
                      <div className="form-group">
                        <label htmlFor="recurrence-interval">Repeat every *</label>
                        <input
                          id="recurrence-interval"
                          name="recurrence_interval"
                          type="number"
                          min="1"
                          max="3650"
                          step="1"
                          value={values.recurrence_interval}
                          onChange={updateField}
                          required
                          disabled={saving}
                        />
                      </div>
                      <div className="form-group">
                        <label htmlFor="recurrence-unit">Interval unit *</label>
                        <select
                          id="recurrence-unit"
                          name="recurrence_unit"
                          value={values.recurrence_unit}
                          onChange={updateField}
                          disabled={saving}
                        >
                          <option value="days">Days</option>
                          <option value="weeks">Weeks</option>
                          <option value="months">Months</option>
                          <option value="years">Years</option>
                        </select>
                      </div>
                    </>
                  )}
                </>
              )}

              {kind === "usage" && (
                <>
                  <div className="form-group">
                    <label htmlFor="variable-id">Numeric usage metric *</label>
                    <select
                      id="variable-id"
                      name="variable_id"
                      value={values.variable_id}
                      onChange={updateField}
                      required
                      disabled={saving || !variables.length}
                    >
                      <option value="">Select a usage metric</option>
                      {variables.map((variable) => (
                        <option key={variable.id} value={String(variable.id)}>
                          {variable.name}{variable.unit ? ` (${variable.unit})` : ""}
                        </option>
                      ))}
                    </select>
                    {!variables.length && <small>No active numeric metrics are available on this asset.</small>}
                  </div>
                  <div className="form-group">
                    <label htmlFor="usage-limit">Alert when usage is at least *</label>
                    <input
                      id="usage-limit"
                      name="usage_limit"
                      type="number"
                      min="0.000001"
                      step="any"
                      value={values.usage_limit}
                      onChange={updateField}
                      required
                      disabled={saving}
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="severity">Severity</label>
                    <select id="severity" name="severity" value={values.severity} onChange={updateField} disabled={saving}>
                      <option value="warning">Warning</option>
                      <option value="alert">Alert</option>
                    </select>
                  </div>
                </>
              )}

              {kind === "time" && (
                <>
                  <div className="form-group">
                    <label htmlFor="planned-start">Planned start date/time *</label>
                    <input
                      id="planned-start"
                      name="planned_start_at"
                      type="datetime-local"
                      value={values.planned_start_at}
                      onChange={updateField}
                      required
                      disabled={saving}
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="planned-end">Planned end date/time *</label>
                    <input
                      id="planned-end"
                      name="planned_end_at"
                      type="datetime-local"
                      value={values.planned_end_at}
                      onChange={updateField}
                      min={values.planned_start_at || undefined}
                      required
                      disabled={saving}
                    />
                  </div>
                </>
              )}

              <div className="form-actions rule-form-actions">
                <button type="button" className="btn-outline" onClick={goBack} disabled={saving}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-primary"
                  disabled={saving || (kind === "usage" && !variables.length)}
                >
                  {saving ? "Saving…" : buttonLabel}
                </button>
              </div>
            </form>
          </div>
        </section>
      </div>
    </div>
  );
}
