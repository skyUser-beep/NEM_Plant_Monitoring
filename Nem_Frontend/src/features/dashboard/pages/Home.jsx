
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useOutletContext } from "react-router-dom";
import { api } from "../../../services/api.js";
import {
  createLiveUpdateScheduler,
  subscribeLiveUpdates,
} from "../../../services/liveUpdates.js";
import { formatDuration, formatValue, timeAgo } from "../../../utils/format.js";
import { EmptyState, Modal } from "../../../components/common/UI.jsx";
import { CheckIcon } from "../../../components/common/Icons.jsx";

const num = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

function Tile({ tone, label, value, to, hint }) {
  const nav = useNavigate();
  const lit = value > 0;

  return (
    <button
      type="button"
      className={"tile " + tone + (lit ? " lit" : "")}
      onClick={() => nav(to)}
      title={hint}
    >
      <span className="tile-label">{label}</span>
      <span className="tile-value">{value}</span>
    </button>
  );
}

export default function Home() {
  const {
    assets = [],
    alerts = [],
    rules = [],
    refreshStatus,
  } = useOutletContext();

  const [summary, setSummary] = useState(null);
  const [plcStatus, setPlcStatus] = useState(null);
  const [monitoringStates, setMonitoringStates] = useState([]);
  const [liveStatusError, setLiveStatusError] = useState("");
  const liveStatusRequest = useRef(false);
  const [error, setError] = useState("");
  const [ackError, setAckError] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [alertToAcknowledge, setAlertToAcknowledge] = useState(null);

  const loadSummary = useCallback(async () => {
    try {
      const result = await api.get("/summary");

      if (!result || typeof result !== "object") {
        throw new Error("The dashboard returned an invalid response.");
      }

      setSummary(result);
      setError("");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to load the dashboard."
      );
    }
  }, []);


  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  const refreshLiveStatus = useCallback(async () => {
    if (liveStatusRequest.current) return;
    liveStatusRequest.current = true;
    try {
      const [plc, states] = await Promise.all([
        api.get("/plc/status"),
        api.getAll("/monitoring/status", 500),
      ]);
      setPlcStatus(plc);
      setMonitoringStates(Array.isArray(states) ? states : []);
      setLiveStatusError("");
    } catch (err) {
      setLiveStatusError(
        err.message || "Unable to refresh live cycle monitoring."
      );
    } finally {
      liveStatusRequest.current = false;
    }
  }, []);

  const refreshLiveScheduler = useMemo(
    () => createLiveUpdateScheduler(refreshLiveStatus),
    [refreshLiveStatus]
  );
  const summaryScheduler = useMemo(
    () => createLiveUpdateScheduler(loadSummary),
    [loadSummary]
  );

  useEffect(() => {
    refreshLiveStatus();
    return subscribeLiveUpdates((update) => {
      if (update.resync_required) {
        refreshLiveScheduler();
        summaryScheduler();
        refreshStatus?.();
        return;
      }
      if (update.type === "disconnected") {
        setLiveStatusError("Live updates disconnected. Reconnecting...");
        return;
      }
      const changedTables = new Set(update.changed_tables || []);
      const liveTables = [
        "assets",
        "variables",
        "readings",
        "nem_readings",
        "nem_monitoring_rules",
        "nem_rule_states",
        "nem_rule_counter_states",
        "machine_monitoring_states",
        "nem_alerts",
      ];
      if (
        update.type === "opcua_status" ||
        liveTables.some((table) => changedTables.has(table))
      ) {
        refreshLiveScheduler();
      }
      if (
        [
          "assets",
          "readings",
          "nem_readings",
          "nem_monitoring_rules",
          "nem_rule_states",
          "nem_alerts",
          "nem_maintenance_schedules",
        ].some((table) => changedTables.has(table))
      ) {
        summaryScheduler();
      }
      if (
        ["nem_monitoring_rules", "nem_rule_states", "nem_alerts"].some(
          (table) => changedTables.has(table)
        )
      ) {
        refreshStatus?.();
      }
    });
  }, [refreshLiveScheduler, refreshStatus, summaryScheduler]);

  useEffect(
    () => () => {
      refreshLiveScheduler.dispose();
      summaryScheduler.dispose();
    },
    [refreshLiveScheduler, summaryScheduler]
  );

  const assetName = useMemo(
    () => new Map(assets.map((a) => [a.id, a.name])),
    [assets]
  );

  const ordered = useMemo(
    () =>
      [...alerts].sort((a, b) => {
        if (a.severity !== b.severity) {
          return a.severity === "alert" ? -1 : 1;
        }

        if (
          Boolean(a.acknowledged_at) !==
          Boolean(b.acknowledged_at)
        ) {
          return a.acknowledged_at ? 1 : -1;
        }

        return new Date(b.started_at) - new Date(a.started_at);
      }),
    [alerts]
  );

  const finishAlertAction = async (action) => {
    if (!alertToAcknowledge || busyId !== null) return;
    const alert = alertToAcknowledge;
    setBusyId(alert.id);
    setAckError("");

    try {
      await api.post(`/alerts/${alert.id}/${action}`);

      await Promise.all([
        loadSummary(),
        refreshLiveStatus(),
        refreshStatus?.(),
      ]);
      setAlertToAcknowledge(null);
    } catch (err) {
      setAckError(
        err.message || (action === "complete"
          ? "Unable to complete this rule."
          : "Unable to acknowledge this alert.")
      );
    } finally {
      setBusyId(null);
    }
  };

  const acknowledgeAlert = () => finishAlertAction("acknowledge");
  const completeAlert = () => finishAlertAction("complete");

  if (!summary && error) {
    return (
      <div className="banner error" role="alert">
        <div>
          <strong>Could not load the overview</strong>
          <p>{error}</p>
        </div>
        <button
          type="button"
          className="btn-outline"
          onClick={loadSummary}
        >
          Retry
        </button>
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="loading" role="status">
        Loading overview…
      </div>
    );
  }

  const rulesAlert = num(summary.rules_alert);
  const rulesWarning = num(summary.rules_warning);
  const assetsAlert = num(summary.assets_alert);
  const assetsWarning = num(summary.assets_warning);
  const monitored = num(summary.monitored_assets);
  const total = num(summary.total_assets);
  const stats = summary.stats ?? {};
  const cycleMappings = (plcStatus?.mappings || []).filter(
    (mapping) =>
      mapping.role === "cycle_signal" &&
      mapping.mapping_valid &&
      mapping.asset_active &&
      mapping.variable_active
  );
  const machinesByAsset = new Map(
    (plcStatus?.machines || []).map((machine) => [
      machine.asset_id,
      machine,
    ])
  );
  const ruleStatesById = new Map(
    monitoringStates.map((state) => [state.rule_id, state])
  );

  const allClear =
    rulesAlert + rulesWarning + assetsAlert + assetsWarning === 0 &&
    alerts.length === 0;

  const coverage =
    total > 0 ? Math.round((monitored / total) * 100) : 0;

  const ruleStats = [
    ["Activated", "activated"],
    ["Suspended", "suspended"],
    ["Deactivated", "deactivated"],
    ["Completed", "completed"],
  ];
  const firstMonitoredAsset = assets.find(
    (asset) =>
      asset.is_active &&
      rules.some(
        (rule) =>
          rule.target_asset_id === asset.id &&
          rule.is_enabled &&
          (rule.lifecycle_status === "in_progress" ||
            rule.lifecycle_status == null)
      )
  );

  return (
    <div className="home">
      <h1 className="page-title">Plant overview</h1>

      {error && (
        <p className="notice error" role="status">
          Showing the last known values. Refresh failed: {error}
        </p>
      )}

      <section className="annunciator" aria-label="Current status">
        <Tile
          tone="alert"
          label="Rules in alert"
          value={rulesAlert}
          to="/rules/alert"
          hint="Open rules currently in alert status"
        />

        <Tile
          tone="warning"
          label="Rules in warning"
          value={rulesWarning}
          to="/rules/warning"
          hint="Open rules currently in warning status"
        />

        <Tile
          tone="alert"
          label="Assets in alert"
          value={assetsAlert}
          to="/rules/alert"
          hint="Assets with an active alert"
        />

        <Tile
          tone="warning"
          label="Assets in warning"
          value={assetsWarning}
          to="/rules/warning"
          hint="Assets with an active warning"
        />
      </section>

      <div className="home-grid">
        <div className="home-left-stack">
          <section className="panel">
            <div className="panel-head">
              <h2>Needs attention</h2>

              <span className="muted">
                {alerts.length === 0
                  ? "Nothing open"
                  : `${alerts.length} active ${
                      alerts.length === 1 ? "alert" : "alerts"
                    }`}
              </span>
            </div>

            {ackError && (
              <p className="notice error" role="alert">
                Could not update this alert: {ackError}
              </p>
            )}

            {ordered.length === 0 ? (
              allClear ? (
                <div className="all-clear">
                  <span className="all-clear-mark">
                    <CheckIcon size={22} />
                  </span>

                  <div>
                    <strong>All machines are within limits</strong>
                    <p className="muted">
                      No rule is in alert or warning.
                    </p>
                  </div>
                </div>
              ) : (
                <EmptyState
                  art={false}
                  title="No active alerts"
                  lines={[
                    "Rule states above may still be changing. Open a rule list to review.",
                  ]}
                />
              )
            ) : (
              <ul className="alert-list">
                {ordered.map((alert) => (
                  <li
                    key={alert.id}
                    className={"alert-row " + alert.severity}
                  >
                    <i
                    className={"lamp " + alert.severity}
                    aria-hidden="true"
                    />

                    <div className="alert-body">
                      <div className="alert-title">
                        {alert.title}
                      </div>

                      <div className="alert-msg">
                        {alert.message}
                      </div>

                      <div className="alert-meta">
                        <Link
                          to={`/assets/${alert.target_asset_id}`}
                          state={alert.maintenance_schedule_id
                            ? {
                                activeTab: "logbook",
                              }
                            : undefined}
                        >
                          {assetName.get(alert.target_asset_id) ||
                            `Asset ${alert.target_asset_id}`}
                        </Link>

                        <span
                          title={new Date(
                            alert.started_at
                          ).toLocaleString()}
                        >
                          Started {timeAgo(alert.started_at)}
                        </span>

                        {alert.trigger_value !== null &&
                          alert.trigger_value !== undefined && (
                            <span>
                              Value {formatValue(alert.trigger_value)}
                            </span>
                          )}
                      </div>
                    </div>

                    <div className="alert-actions">
                      {alert.acknowledged_at && (
                        <span
                          className="ack-done"
                          title={new Date(
                            alert.acknowledged_at
                          ).toLocaleString()}
                        >
                          Acknowledged
                          {alert.acknowledged_by
                            ? ` by ${alert.acknowledged_by}`
                            : ""}
                        </span>
                      )}
                      {alert.acknowledged_at && alert.rule_id ? (
                        <button
                          type="button"
                          className="btn-outline"
                          disabled={busyId === alert.id}
                          onClick={() => {
                            setAckError("");
                            setAlertToAcknowledge(alert);
                          }}
                        >
                          {busyId === alert.id ? "Saving…" : "Complete"}
                        </button>
                      ) : !alert.acknowledged_at ? (
                        <button
                          type="button"
                          className="btn-outline"
                          disabled={busyId === alert.id}
                          onClick={() => {
                            setAckError("");
                            setAlertToAcknowledge(alert);
                          }}
                        >
                          {busyId === alert.id ? "Saving…" : "Acknowledge"}
                        </button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Rules by state</h2>
            </div>

            <ul className="state-grid">
              {ruleStats.map(([label, key]) => (
                <li key={key}>
                  <Link
                    to={
                      key === "activated" && firstMonitoredAsset
                        ? `/assets/${firstMonitoredAsset.id}`
                        : `/rules/${key}`
                    }
                  >
                    <span>{label}</span>
                    <b>{num(stats[key])}</b>
                  </Link>
                </li>
                ))}
            </ul>
          </section>
        </div>

        <aside className="home-right-column">
          <section className="panel">
            <div className="panel-head">
              <h2>Monitoring coverage</h2>
            </div>

            <Link to="/assets" className="coverage">
              <span className="coverage-num">
                {monitored}
                <small> of {total} assets</small>
              </span>

              <span className="meter" aria-hidden="true">
                <i style={{ width: `${coverage}%` }} />
              </span>

              <span className="muted">
                have enabled rules monitoring active variables
              </span>
            </Link>
          </section>
        </aside>
      </div>
      {alertToAcknowledge && (
        <Modal
          title="Confirm alert action"
          onClose={() => {
            if (busyId === null) setAlertToAcknowledge(null);
          }}
        >
          <p>
            {alertToAcknowledge.rule_id
              ? "Is the condition resolved and ready for this rule to be completed? Choose “No” to record your acknowledgement while keeping the alert active. Cancel makes no changes."
              : "Acknowledge that you have seen this maintenance alert. Resolve it through maintenance management when the scheduled work is complete. Cancel makes no changes."}
          </p>
          {ackError && (
            <p className="notice error" role="alert">{ackError}</p>
          )}
          <div className="modal-actions">
            <button
              type="button"
              className="btn-outline"
              disabled={busyId !== null}
              onClick={() => setAlertToAcknowledge(null)}
            >
              Cancel
            </button>
            {!alertToAcknowledge.acknowledged_at && (
              <button
                type="button"
                className="btn-outline"
                disabled={busyId !== null}
                onClick={acknowledgeAlert}
              >
                {busyId === alertToAcknowledge.id
                  ? "Saving…"
                  : "No, acknowledge only"}
              </button>
            )}
            {alertToAcknowledge.rule_id && (
              <button
                type="button"
                className="btn-primary"
                disabled={busyId !== null}
                onClick={completeAlert}
              >
                {busyId === alertToAcknowledge.id
                  ? "Saving…"
                  : "Yes, complete rule"}
              </button>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
