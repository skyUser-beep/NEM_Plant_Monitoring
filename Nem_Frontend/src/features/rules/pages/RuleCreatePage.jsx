import React, { useEffect, useState } from "react";
import {
  useLocation,
  useNavigate,
  useOutletContext,
  useParams,
} from "react-router-dom";
import { api } from "../../../services/api.js";
import { useAuth } from "../../auth/AuthContext.jsx";
import { buildAssetMonitoringRule } from "../../assets/rules/monitoringRuleFlow.js";
import {
  rememberNavigationOrigin,
  returnToNavigationOrigin,
} from "../../../utils/navigation.js";
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
  const { user } = useAuth();
  const canManageRules = ["Administrator", "Supervisor"].includes(user?.role);
  const { id, kind } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { assets = [] } = useOutletContext() || {};
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
    async function loadRuleInputs() {
      try {
        const [items, plcStatus] = await Promise.all([
          api.getAll(`/assets/${assetId}/variables?is_active=true`),
          canManageRules ? api.get("/plc/status") : Promise.resolve(null),
        ]);
        if (!active) return;

        const activeVariables = (Array.isArray(items) ? items : [])
          .filter((item) => item.is_active !== false);
        const mappings = Array.isArray(plcStatus?.mappings)
          ? plcStatus.mappings
          : [];
        const validBooleanMappings = mappings.filter(
          (mapping) =>
            Number(mapping.asset_id) === assetId &&
            mapping.mapping_valid &&
            mapping.data_type === "boolean"
        );

        setVariables(activeVariables);
        setCycleVariableIds(
          validBooleanMappings
            .filter((mapping) => mapping.role === "cycle_signal")
            .map((mapping) => Number(mapping.variable_id))
        );
        setRuntimeVariableIds(
          validBooleanMappings
            .filter((mapping) => mapping.role === "running_signal")
            .map((mapping) => Number(mapping.variable_id))
        );
        const cycleVariableId = validBooleanMappings.find(
          (mapping) => mapping.role === "cycle_signal"
        )?.variable_id;
        const runtimeVariableId = validBooleanMappings.find(
          (mapping) => mapping.role === "running_signal"
        )?.variable_id;
        setValues((current) => ({
          ...current,
          cycle_variable_id:
            current.cycle_variable_id || (cycleVariableId != null ? String(cycleVariableId) : ""),
          runtime_variable_id:
            current.runtime_variable_id || (runtimeVariableId != null ? String(runtimeVariableId) : ""),
        }));
      } catch (requestError) {
        if (active) {
          setError(
            requestError.message ||
              "Could not load this asset's rule variables and PLC mappings."
          );
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    loadRuleInputs();
    return () => {
      active = false;
    };
  }, [assetId, canManageRules]);

  const returnFallback = {
    pathname: `/assets/${id}`,
    state: { activeTab: "status" },
  };
  useEffect(() => {
    rememberNavigationOrigin(location.state?.from);
  }, [location.state?.from]);

  const goBack = () =>
    returnToNavigationOrigin(
      navigate,
      location.state?.from,
      returnFallback
    );

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
    if (!canManageRules) return;
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
      const rule = buildAssetMonitoringRule(
        {
          ...values,
          rule_type: isUsage
            ? "boolean_count_threshold"
            : "runtime_duration",
        },
        assetId,
        {
          variables,
          cycleVariableIds,
          runtimeVariableIds,
        }
      );
      await api.post(`/assets/${assetId}/rules`, rule);
      returnToNavigationOrigin(
        navigate,
        location.state?.from,
        returnFallback,
        { notice: { text: `Rule "${rule.name}" created successfully.` } }
      );
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
              {!canManageRules && (
                <p className="notice" role="status">
                  You do not have permission to create monitoring rules.
                </p>
              )}
              <div className="form-group">
                <label htmlFor="rule-name">Rule name *</label>
                <input
                  id="rule-name"
                  name="name"
                  value={values.name}
                  onChange={updateField}
                  placeholder={isUsage ? "e.g. Rotation count limit" : "e.g. Machine running time"}
                  required
                  disabled={saving || !canManageRules}
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
                  disabled={saving || !canManageRules}
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
                      disabled={saving || !canManageRules || !cycleVariableOptions.length}
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
                      disabled={saving || !canManageRules}
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
                      disabled={saving || !canManageRules}
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
                      disabled={saving || !canManageRules}
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="form-group">
  <label htmlFor="variable-id">Boolean running signal *</label>

  <select
    id="variable-id"
    name="runtime_variable_id"
    value={values.runtime_variable_id}
    onChange={updateField}
    required
    disabled={saving || !canManageRules || !runtimeVariableOptions.length}
  >
    <option value="">Select the machine running signal</option>

    {runtimeVariableOptions.map((variable) => (
      <option key={variable.id} value={String(variable.id)}>
        {variable.name}
      </option>
    ))}
  </select>

  {!runtimeVariableOptions.length && (
    <small>
      No running signal is configured. In the asset's Variables panel, set a Boolean variable's purpose to Machine running state.
    </small>
  )}
</div>
                  {isScheduled && (
                    <div className="form-group">
                      <label htmlFor="activation-at">Activate on *</label>
                      <input
                        id="activation-at"
                        name="activation_at"
                        type="datetime-local"
                        value={values.activation_at}
                        onChange={updateField}
                        required
                        disabled={saving || !canManageRules}
                      />
                    </div>
                  )}
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
                      disabled={saving || !canManageRules}
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
                      disabled={saving || !canManageRules}
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
                      disabled={saving || !canManageRules}
                    />
                  </div>
                </>
              )}

              <div className="form-actions rule-form-actions">
                <button type="button" className="btn-outline" onClick={goBack} disabled={saving}>
                  Cancel
                </button>
                <button type="submit" className="btn-primary" disabled={disableSubmit || !canManageRules} title={!canManageRules ? "You do not have permission to create monitoring rules." : undefined}>
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
