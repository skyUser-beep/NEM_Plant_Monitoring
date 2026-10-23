import React, { useEffect, useState } from "react";
import { useNavigate, useOutletContext, useParams } from "react-router-dom";
import { api } from "../../../services/api.js";
import { buildAssetMonitoringRule } from "../../assets/rules/monitoringRuleFlow.js";
import "./RuleCreatePage.css";

const TITLES = {
  interval: "Create Motor Running Time rule",
  usage: "Create Cycle Clock rule",
  time: "Create scheduled Running Time rule",
};

const INITIAL_VALUES = {
  name: "",
  description: "",
  cycle_variable_id: "",
  runtime_variable_id: "",
  severity: "warning",
  warning_threshold_1: "",
  warning_threshold_2: "",
  alert_threshold: "",
  runtime_warning_hours: "",
  runtime_warning_2_hours: "",
  runtime_alert_hours: "",
  activation_at: "",
};

export default function RuleCreatePage() {
  const { id, kind } = useParams();
  const navigate = useNavigate();
  const { assets = [], refreshStatus } = useOutletContext() || {};
  const assetId = Number(id);
  const asset = assets.find((item) => Number(item.id) === assetId);
  const isUsage = kind === "usage";
  const isScheduled = kind === "time";

  const [variables, setVariables] = useState([]);
  const [cycleVariableIds, setCycleVariableIds] = useState([]);
  const [runtimeVariableIds, setRuntimeVariableIds] = useState([]);
  const [values, setValues] = useState({ ...INITIAL_VALUES });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    Promise.all([
      api.getAll(`/assets/${assetId}/variables?is_active=true`),
      api.get("/plc/status"),
    ])
      .then(([items, plc]) => {
        if (!active) return;
       const activeVariables = (Array.isArray(items) ? items : [])
  .filter((item) => item.is_active !== false);

setVariables(activeVariables);

if (activeVariables.length) {
  setValues((current) => ({
    ...current,
    variable_id: String(activeVariables[0].id),
  }));
}
      })
      .catch((requestError) => {
        if (active) {
          setError(
            requestError.message ||
              "Could not load this asset's Boolean OPC UA variables."
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [assetId]);

  const goBack = () =>
    navigate(`/assets/${id}`, { state: { activeTab: "status" } });

  const updateField = (event) => {
    const { name, value } = event.target;
    setValues((current) => ({ ...current, [name]: value }));
    setError("");
  };

  const runtimeVariableOptions = variables.filter(
    (variable) =>
      variable.data_type === "boolean" &&
      runtimeVariableIds.includes(Number(variable.id))
  );
  const cycleVariableOptions = variables.filter(
    (variable) =>
      variable.data_type === "boolean" &&
      cycleVariableIds.includes(Number(variable.id))
  );

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (saving) return;
    setError("");
    if (!values.name.trim()) {
      setError("Please enter a rule name.");
      return;
    }
    if (isScheduled && !values.activation_at) {
      setError("Choose when the time-based rule should activate.");
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

  const selectedVariable = variables.find(
    (item) => String(item.id) === values.variable_id
  );

  if (!selectedVariable) {
    throw new Error("Select an active variable.");
  }

  if (!["number", "integer"].includes(selectedVariable.data_type)) {
    throw new Error(
      "Usage threshold rules currently support numeric variables only."
    );
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
      } else {
        throw new Error("Unknown workflow type.");
      }
    } catch (requestError) {
      setError(requestError.message || "Could not create the monitoring rule.");
    } finally {
      setSaving(false);
    }
  };

  if (!TITLES[kind]) {
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
  return (
    <div className="loading" role="status">
      Loading variables…
    </div>
  );
}

  const disableSubmit =
    saving ||
    (isUsage && cycleVariableOptions.length === 0) ||
    (!isUsage && runtimeVariableOptions.length === 0);

  return (
    <div className={`rule-create-page rule-create-page-${kind}`}>
      <div className="rule-create-container">
       <button
         type="button"
         className="btn-outline rule-back-btn"
         onClick={goBack}
       >
         ← Back to Asset
       </button>

       <div className="page-head rule-page-head">
         <span className="rule-create-kicker">MONITORING RULE</span>
         <h1 className="page-title rule-page-title">{TITLES[kind]}</h1>
         <p className="muted rule-page-subtitle">
           <span>Asset</span>
           <strong>{asset?.name || `#${assetId}`}</strong>
         </p>
       </div>

       <section className="rule-create-card">
         <div className="rule-create-card-header">
           <span className="rule-create-section-label">RULE CONFIGURATION</span>
           <h2>Set up your monitoring rule</h2>
           <p>
              {isUsage
                ? "Each complete OFF-to-ON cycle increments the counter and is checked against the warning and alert thresholds."
                : isScheduled
                  ? "At the scheduled time, runtime tracking begins, counts only while the selected Boolean signal is ON, and continues until the rule is deactivated."
                  : "Running time accumulates while the selected Boolean signal is ON and is checked against the thresholds."}
            </p>
          </div>

          <div className="rule-create-form">
            {error && <p role="alert" className="error-message">{error}</p>}
            <form onSubmit={handleSubmit}>
              <div className="form-group">
                <label htmlFor="rule-name">Rule name *</label>
                <input
                  id="rule-name"
                  name="name"
                  value={values.name}
                  onChange={updateField}
                  placeholder={isUsage ? "e.g. Rotation count limit" : "e.g. Machine running time"}
                  required
                  disabled={saving}
                />
              </div>

              <div className="form-group form-group-description">
                <label htmlFor="rule-description">Description <span className="optional-label">Optional</span></label>
                <textarea
                  id="rule-description"
                  name="description"
                  rows={3}
                  value={values.description}
                  onChange={updateField}
                  placeholder="Add context for operators who will review this rule."
                  disabled={saving}
                />
              </div>

              {isUsage ? (
                <>
                  <div className="form-group">
                    <label htmlFor="cycle-variable">Boolean cycle signal *</label>
                    <select
                      id="cycle-variable"
                      name="cycle_variable_id"
                      value={values.cycle_variable_id}
                      onChange={updateField}
                      required
                      disabled={saving || !cycleVariableOptions.length}
                    >
                      <option value="">Select the cycle on/off variable</option>
                      {cycleVariableOptions.map((variable) => (
                        <option key={variable.id} value={String(variable.id)}>
                          {variable.name}
                        </option>
                      ))}
                    </select>
                    {!cycleVariableOptions.length && (
                      <small>
                        No cycle signal is configured. In the asset's Variables panel, edit the Boolean variable and set its purpose to Cycle signal.
                      </small>
                    )}
                  </div>
                  <div className="form-group">
                    <label htmlFor="warning-1">First warning at cycle count *</label>
                    <input
                      id="warning-1"
                      name="warning_threshold_1"
                      type="number"
                      min="1"
                      step="1"
                      value={values.warning_threshold_1}
                      onChange={updateField}
                      required
                      disabled={saving}
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="warning-2">Higher warning at cycle count *</label>
                    <input
                      id="warning-2"
                      name="warning_threshold_2"
                      type="number"
                      min="1"
                      step="1"
                      value={values.warning_threshold_2}
                      onChange={updateField}
                      required
                      disabled={saving}
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="cycle-alert">Alert at cycle count *</label>
                    <input
                      id="cycle-alert"
                      name="alert_threshold"
                      type="number"
                      min="1"
                      step="1"
                      value={values.alert_threshold}
                      onChange={updateField}
                      required
                      disabled={saving}
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="form-group">
  <label htmlFor="variable-id">Add a variable *</label>

  <select
    id="variable-id"
    name="variable_id"
    value={values.variable_id}
    onChange={updateField}
    required
    disabled={saving || !variables.length}
  >
    <option value="">Select a variable</option>

    {variables.map((variable) => (
      <option key={variable.id} value={String(variable.id)}>
        {variable.name}
        {variable.unit ? ` (${variable.unit})` : ""}
        {variable.data_type ? ` — ${variable.data_type}` : ""}
      </option>
    ))}
  </select>

  {!variables.length && (
    <small>No active variables are available on this asset.</small>
  )}
</div>
                  <div className="form-group">
                    <label htmlFor="runtime-warning">Warning after running (hours) *</label>
                    <input
                      id="runtime-warning"
                      name="runtime_warning_hours"
                      type="number"
                      min="0.000001"
                      step="any"
                      value={values.runtime_warning_hours}
                      onChange={updateField}
                      required
                      disabled={saving}
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="runtime-warning-2">Higher warning after running (hours) *</label>
                    <input
                      id="runtime-warning-2"
                      name="runtime_warning_2_hours"
                      type="number"
                      min="0.000001"
                      step="any"
                      value={values.runtime_warning_2_hours}
                      onChange={updateField}
                      required
                      disabled={saving}
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="runtime-alert">Alert after running (hours) *</label>
                    <input
                      id="runtime-alert"
                      name="runtime_alert_hours"
                      type="number"
                      min="0.000001"
                      step="any"
                      value={values.runtime_alert_hours}
                      onChange={updateField}
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
                <button type="submit" className="btn-primary" disabled={disableSubmit}>
                  {saving ? "Saving…" : isScheduled ? "Create scheduled rule" : isUsage ? "Create Cycle Clock rule" : "Create Motor Running Time rule"}
                </button>
              </div>
            </form>
          </div>
        </section>
      </div>
    </div>
  );
}
