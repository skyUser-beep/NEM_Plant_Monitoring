

import React, { useEffect, useMemo, useState } from "react";
import { api } from "../../../services/api.js";
import "./CopyRulesModal.css";

export default function CopyRulesModal({
  assetId,
  assets = [],
  cycleVariableIds = [],
  onClose,
  onCopied,
}) {
  const [sourceId, setSourceId] = useState("");
  const [sourceRules, setSourceRules] = useState([]);
  const [sourceVariables, setSourceVariables] = useState([]);
  const [destinationVariables, setDestinationVariables] = useState([]);
  const [selected, setSelected] = useState([]);
  const [includeDisabled, setIncludeDisabled] = useState(true);
  const [reviewing, setReviewing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState(null);

  const otherAssets = useMemo(
    () =>
      assets.filter(
        (asset) => Number(asset.id) !== Number(assetId)
      ),
    [assets, assetId]
  );

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, saving]);

  useEffect(() => {
    let alive = true;

    api
      .getAll(`/assets/${assetId}/variables?is_active=true`)
      .then((items) => {
        if (alive) {
          setDestinationVariables(
            Array.isArray(items) ? items : []
          );
        }
      })
      .catch((err) => {
        if (alive) {
          setError(
            err.message ||
              "Destination variables could not be loaded."
          );
        }
      });

    return () => {
      alive = false;
    };
  }, [assetId]);

  const loadSource = async (value) => {
    setSourceId(value);
    setSourceRules([]);
    setSourceVariables([]);
    setSelected([]);
    setResults(null);
    setReviewing(false);
    setError("");

    if (!value) return;

    setLoading(true);

    try {
      const [rules, variables] = await Promise.all([
        api.get(`/assets/${value}/rules`),
        api.getAll(
          `/assets/${value}/variables?is_active=true`
        ),
      ]);

      setSourceRules(Array.isArray(rules) ? rules : []);
      setSourceVariables(
        Array.isArray(variables) ? variables : []
      );
    } catch (err) {
      setError(
        err.message ||
          "Source asset rules could not be loaded."
      );
    } finally {
      setLoading(false);
    }
  };

  const getMapping = (rule) => {
    if (rule.variable_id == null) {
      return { variable: null, reason: "" };
    }

    const sourceVariable = sourceVariables.find(
      (variable) =>
        Number(variable.id) === Number(rule.variable_id)
    );

    if (!sourceVariable) {
      return {
        variable: null,
        reason: "Source variable is missing or inactive.",
      };
    }

    const matches = destinationVariables.filter(
      (variable) =>
        variable.key?.trim().toLowerCase() ===
          sourceVariable.key?.trim().toLowerCase() &&
        variable.data_type === sourceVariable.data_type
    );

    if (matches.length !== 1) {
      return {
        variable: null,
        reason: matches.length
          ? "Multiple destination variables match this key."
          : `No active destination variable matches "${sourceVariable.key}" and its data type.`,
      };
    }

    const variable = matches[0];

    if (
      rule.rule_type === "parameter_threshold" &&
      !["number", "integer"].includes(variable.data_type)
    ) {
      return {
        variable: null,
        reason:
          "This rule requires a numeric destination variable.",
      };
    }

    if (rule.rule_type === "boolean_count_threshold") {
      if (variable.data_type !== "boolean") {
        return {
          variable: null,
          reason:
            "This rule requires a Boolean variable.",
        };
      }

      if (
        !cycleVariableIds.some(
          (id) => Number(id) === Number(variable.id)
        )
      ) {
        return {
          variable: null,
          reason:
            "This destination variable is not configured as the active cycle signal.",
        };
      }
    }

    return { variable, reason: "" };
  };

  const getRuleStatus = (rule) => {
    const supported = [
      "parameter_threshold",
      "runtime_duration",
      "duration",
      "generic",
      "boolean_count_threshold",
    ];

    if (!supported.includes(rule.rule_type)) {
      return {
        variable: null,
        reason: `Unsupported rule type: ${
          rule.rule_type || "unknown"
        }.`,
      };
    }
    if (rule.rule_type === "generic") {
      return {
        variable: null,
        reason: "This rule type has no monitoring evaluator.",
      };
    }

    const mapping = getMapping(rule);

    if (mapping.reason) return mapping;

    if (
      [
        "parameter_threshold",
        "boolean_count_threshold",
        "generic",
      ].includes(rule.rule_type) &&
      !mapping.variable
    ) {
      return {
        variable: null,
        reason:
          "This rule needs a mapped destination variable.",
      };
    }

    if (rule.rule_type === "duration") {
      const parameters = rule.parameters || {};

      if (
        !Number.isFinite(
          Number(parameters.duration_seconds)
        ) ||
        Number(parameters.duration_seconds) <= 0
      ) {
        return {
          variable: null,
          reason:
            "Duration settings are missing or invalid.",
        };
      }

      if (!mapping.variable) {
        return {
          variable: null,
          reason:
            "This duration rule needs a mapped destination variable.",
        };
      }
    }

    if (rule.rule_type === "runtime_duration") {
      const seconds = Number(
        rule.parameters?.duration_seconds
      );

      if (!Number.isFinite(seconds) || seconds <= 0) {
        return {
          variable: null,
          reason:
            "Runtime duration settings are missing or invalid.",
        };
      }
    }

    if (rule.rule_type === "parameter_threshold") {
      if (
        !rule.operator ||
        rule.threshold == null ||
        !Number.isFinite(Number(rule.threshold))
      ) {
        return {
          variable: null,
          reason:
            "Threshold settings are missing or invalid.",
        };
      }
    }

    if (rule.rule_type === "boolean_count_threshold") {
      const parameters = rule.parameters || {};
      const thresholds = parameters.warning_thresholds;
      const alert = Number(parameters.alert_threshold);

      if (
        !Array.isArray(thresholds) ||
        thresholds.length !== 2 ||
        !thresholds.every(
          (value) =>
            Number.isSafeInteger(Number(value)) &&
            Number(value) > 0
        ) ||
        Number(thresholds[0]) >= Number(thresholds[1]) ||
        !Number.isSafeInteger(alert) ||
        alert <= Number(thresholds[1])
      ) {
        return {
          variable: null,
          reason: "Boolean count thresholds are invalid.",
        };
      }
    }

    return mapping;
  };

  const eligibleRules = useMemo(
    () =>
      sourceRules.map((rule) => ({
        ...rule,
        copyCheck: getRuleStatus(rule),
      })),
    [
      sourceRules,
      sourceVariables,
      destinationVariables,
      cycleVariableIds,
    ]
  );

  const copyableRules = eligibleRules.filter(
    (rule) => !rule.copyCheck.reason
  );

  const toggleRule = (id) => {
    setReviewing(false);
    setSelected((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id]
    );
  };

  const copyRules = async () => {
    if (!selected.length || saving) return;

    setSaving(true);
    setError("");

    try {
      const result = await api.post(`/assets/${assetId}/rules/copy`, {
        source_asset_id: Number(sourceId),
        rule_ids: selected.map(Number),
        include_disabled: includeDisabled,
      });
      setResults({
        copied: result.created || [],
        alreadyCopied: result.already_copied || [],
        excludedDisabled: result.excluded_disabled || 0,
      });
      setSelected([]);
      setReviewing(false);
      if (result.created?.length) await onCopied?.(result);
    } catch (err) {
      setError(err.message || "Could not copy the selected rules.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
  className="copy-rules-overlay"
  onMouseDown={(event) => {
    if (event.target === event.currentTarget && !saving) onClose();
  }}
>
      <section
        className="modal copy-rules-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="copy-rules-title"
      >
        <header className="modal-header">
          <h2 id="copy-rules-title">
            Copy rules from another asset
          </h2>

          <button
            type="button"
            className="copy-rules-close"
            onClick={onClose}
            disabled={saving}
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className="modal-body">
          <p>
            Select a source asset and choose which rules to
            copy. New rules will be created disabled on this
            asset; the source rules will not be changed.
          </p>

          <label
            className="field-label"
            htmlFor="copy-rules-source"
          >
            Source asset
          </label>

          <select
            id="copy-rules-source"
            className="form-input"
            value={sourceId}
            onChange={(event) =>
              loadSource(event.target.value)
            }
            disabled={saving}
          >
            <option value="">Select an asset</option>

            {otherAssets.map((asset) => (
              <option key={asset.id} value={asset.id}>
                {asset.name}
              </option>
            ))}
          </select>

          {!otherAssets.length && (
            <p className="copy-rules-loading">No other assets are available.</p>
          )}

          {loading && (
  <p className="copy-rules-loading">
    Loading rules and variables...
  </p>
)}

          {sourceId && !loading && (
            <>
              <label className="copy-rules-include-disabled">
                <input
                  type="checkbox"
                  checked={includeDisabled}
                  disabled={saving}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setIncludeDisabled(checked);
                    if (!checked) {
                      setSelected((current) => current.filter((id) =>
                        sourceRules.find((rule) => rule.id === id)?.is_enabled
                      ));
                    }
                    setReviewing(false);
                  }}
                />
                Include deactivated rules
              </label>
              <div className="copy-rules-summary">
                {copyableRules.length} copyable of{" "}
                {sourceRules.length} rules
                {" · "}
                {selected.length} selected
              </div>

              {!sourceRules.length && (
                <p>This asset has no rules to copy.</p>
              )}

              <div className="copy-rules-list">
                {eligibleRules.map((rule) => {
                  const reason = rule.copyCheck.reason;
                  const deactivated = !rule.is_enabled;
                  const excluded = deactivated && !includeDisabled;

                  return (
                    <label
                      className="copy-rule-row"
                      key={rule.id}
                    >
                      <input
                        type="checkbox"
                        checked={selected.includes(rule.id)}
                        disabled={saving || Boolean(reason) || excluded}
                        onChange={() => toggleRule(rule.id)}
                      />

                      <span className="copy-rule-content">
                        <strong>{rule.name}</strong>

                        <small>
                          {rule.rule_type} · {rule.severity} · {deactivated ? "Deactivated" : "Activated"}
                          {rule.copyCheck.variable
                            ? ` · Variable: ${rule.copyCheck.variable.name}`
                            : ""}
                        </small>

                        {reason && (
                          <small className="form-error">
                            {reason}
                          </small>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
            </>
          )}

          {reviewing && (
            <div className="copy-rules-confirmation" role="status">
              Copy {selected.length} selected rule(s) to this asset? Source rules will remain unchanged; copied rules will be created inactive.
            </div>
          )}

          {results && (
            <div
              className="copy-rules-results"
              role="status"
            >
              <strong>
                {results.copied.length} rule(s) copied.
              </strong>

              {results.copied.length > 0 && (
                <p>
                  Created disabled:{" "}
                  {results.copied.map((rule) => rule.name).join(", ")}
                </p>
              )}

              {results.alreadyCopied.length > 0 && (
                <p>{results.alreadyCopied.length} matching rule(s) were already on this asset.</p>
              )}
              {results.excludedDisabled > 0 && (
                <p>{results.excludedDisabled} deactivated rule(s) were excluded.</p>
              )}
            </div>
          )}
        </div>

        <footer className="modal-actions">
          <button
            type="button"
            className="btn-outline"
            onClick={onClose}
            disabled={saving}
          >
            Close
          </button>

          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              if (reviewing) copyRules();
              else setReviewing(true);
            }}
            disabled={saving || !selected.length || loading}
          >
            {saving
              ? "Copying…"
              : reviewing
                ? `Confirm copy (${selected.length})`
                : `Review copy (${selected.length})`}
          </button>
        </footer>
      </section>
    </div>
  );
}
