
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useOutletContext,
} from "react-router-dom";
import { api } from "../../../services/api.js";
import {
  createLiveUpdateScheduler,
  subscribeLiveUpdates,
} from "../../../services/liveUpdates.js";
import {
  formatDuration,
  formatTime,
  formatValue,
  timeAgo,
} from "../../../utils/format.js";
import { EmptyState, Modal } from "../../../components/common/UI.jsx";
import { CheckIcon } from "../../../components/common/Icons.jsx";
import { captureNavigationOrigin } from "../../../utils/navigation.js";

const num = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

function localCalendarDay(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function Tile({ tone, label, value, to, hint }) {
  const nav = useNavigate();
  const location = useLocation();
  const lit = value > 0;

  return (
    <button
      type="button"
      className={"tile " + tone + (lit ? " lit" : "")}
      onClick={() =>
        nav(to, {
          state: { from: captureNavigationOrigin(location) },
        })
      }
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
  const previousRuleStatusSignature = useRef(null);
  const [liveStatusError, setLiveStatusError] = useState("");
  const liveStatusRequest = useRef(false);
  const [error, setError] = useState("");
  const [ackError, setAckError] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [alertAction, setAlertAction] = useState(null);
  const [evaluatedAlerts, setEvaluatedAlerts] = useState([]);
  const [evaluatedAlertsError, setEvaluatedAlertsError] = useState("");
  const [evaluatedDay, setEvaluatedDay] = useState(() => localCalendarDay());
  const evaluatedDayRef = useRef(evaluatedDay);

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

  const loadEvaluatedAlerts = useCallback(async () => {
    try {
      const [completed, resolved] = await Promise.all([
        api.get("/events?event_type=alert_completed&limit=20&offset=0"),
        api.get("/events?event_type=alert_resolved&limit=20&offset=0"),
      ]);
      const items = [
        ...(Array.isArray(completed) ? completed : []).map((event) => ({
          ...event,
          workflow_status: "completed",
        })),
        ...(Array.isArray(resolved) ? resolved : []).map((event) => ({
          ...event,
          workflow_status: "evaluated",
        })),
      ];
      items.sort(
        (left, right) =>
          new Date(right.occurred_at).getTime() -
          new Date(left.occurred_at).getTime()
      );
      setEvaluatedAlerts(items.slice(0, 20));
      setEvaluatedAlertsError("");
    } catch (err) {
      setEvaluatedAlertsError(
        err.message || "Unable to load evaluated alerts."
      );
    }
  }, []);

  useEffect(() => {
    let midnightTimer;
    let disposed = false;

    const refreshDay = () => {
      const currentDay = localCalendarDay();
      if (evaluatedDayRef.current !== currentDay) {
        evaluatedDayRef.current = currentDay;
        setEvaluatedDay(currentDay);
        void loadEvaluatedAlerts();
      }
    };

    const scheduleMidnightRefresh = () => {
      if (disposed) return;
      window.clearTimeout(midnightTimer);
      const now = new Date();
      const nextMidnight = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1
      );
      midnightTimer = window.setTimeout(() => {
        refreshDay();
        scheduleMidnightRefresh();
      }, Math.max(0, nextMidnight.getTime() - now.getTime()) + 100);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshDay();
      scheduleMidnightRefresh();
    };

    scheduleMidnightRefresh();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      disposed = true;
      window.clearTimeout(midnightTimer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [loadEvaluatedAlerts]);

  useEffect(() => {
    loadSummary();
    loadEvaluatedAlerts();
  }, [loadEvaluatedAlerts, loadSummary]);

  const visibleEvaluatedAlerts = useMemo(
    () =>
      evaluatedAlerts.filter((event) => {
        const occurredAt = new Date(event.occurred_at);
        return (
          !Number.isNaN(occurredAt.getTime()) &&
          localCalendarDay(occurredAt) === evaluatedDay
        );
      }),
    [evaluatedAlerts, evaluatedDay]
  );

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
  const evaluatedAlertsScheduler = useMemo(
    () => createLiveUpdateScheduler(loadEvaluatedAlerts),
    [loadEvaluatedAlerts]
  );

  useEffect(() => {
    const signature = monitoringStates
      .map((state) => `${state.rule_id}:${state.status}`)
      .sort()
      .join("|");

    if (
      previousRuleStatusSignature.current === null &&
      monitoringStates.length === 0
    ) {
      return;
    }

    if (previousRuleStatusSignature.current === null) {
      previousRuleStatusSignature.current = signature;
      return;
    }

    if (previousRuleStatusSignature.current !== signature) {
      previousRuleStatusSignature.current = signature;
      summaryScheduler();
    }
  }, [monitoringStates, summaryScheduler]);

  useEffect(() => {
    refreshLiveStatus();
    return subscribeLiveUpdates((update) => {
      if (update.resync_required) {
        refreshLiveScheduler();
        summaryScheduler();
        evaluatedAlertsScheduler();
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
          "variables",
          "nem_monitoring_rules",
          "nem_alerts",
          "nem_maintenance_schedules",
        ].some((table) => changedTables.has(table))
      ) {
        summaryScheduler();
      }
      if (
        changedTables.has("nem_monitoring_events") ||
        changedTables.has("nem_alerts")
      ) {
        evaluatedAlertsScheduler();
      }
    });
  }, [
    evaluatedAlertsScheduler,
    refreshLiveScheduler,
    summaryScheduler,
  ]);

  useEffect(
    () => () => {
      refreshLiveScheduler.dispose();
      summaryScheduler.dispose();
      evaluatedAlertsScheduler.dispose();
    },
    [evaluatedAlertsScheduler, refreshLiveScheduler, summaryScheduler]
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
    if (!alertAction || busyId !== null) return;
    const alert = alertAction.alert;
    setBusyId(alert.id);
    setAckError("");

    try {
      await api.post(`/alerts/${alert.id}/${action}`);

      await Promise.all([
        loadSummary(),
        loadEvaluatedAlerts(),
        refreshLiveStatus(),
        refreshStatus?.(),
      ]);
      setAlertAction(null);
    } catch (err) {
      setAckError(
        err.message || (action === "complete"
          ? "Unable to complete this alert."
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
                      <span
                        className={`alert-status ${
                          alert.acknowledged_at
                            ? "alert-status--acknowledged"
                            : "alert-status--attention"
                        }`}
                        title={
                          alert.acknowledged_at
                            ? new Date(alert.acknowledged_at).toLocaleString()
                            : undefined
                        }
                      >
                        {alert.acknowledged_at
                          ? `Acknowledged${
                              alert.acknowledged_by
                                ? ` by ${alert.acknowledged_by}`
                                : ""
                            }`
                          : "Needs Attention"}
                      </span>
                      {alert.acknowledged_at ? (
                        <button
                          type="button"
                          className="btn-outline"
                          disabled={busyId === alert.id}
                          onClick={() => {
                            setAckError("");
                            setAlertAction({
                              alert,
                              action: "complete",
                            });
                          }}
                        >
                          {busyId === alert.id ? "Saving…" : "Complete"}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn-outline"
                          disabled={busyId === alert.id}
                          onClick={() => {
                            setAckError("");
                            setAlertAction({
                              alert,
                              action: "acknowledge",
                            });
                          }}
                        >
                          {busyId === alert.id ? "Saving…" : "Acknowledge"}
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
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

        <section className="panel home-evaluated-panel">
            <div className="panel-head">
              <h2>Evaluated / completed alerts</h2>
              <span className="muted">{visibleEvaluatedAlerts.length} today</span>
            </div>
            {evaluatedAlertsError && (
              <p className="notice error" role="alert">
                {evaluatedAlertsError}
              </p>
            )}
            {visibleEvaluatedAlerts.length === 0 ? (
              <EmptyState
                art={false}
                title="No evaluated or completed alerts"
                lines={["Today's completed and cleared alerts will appear here."]}
              />
            ) : (
              <ul className="alert-list evaluated-alert-list">
                {visibleEvaluatedAlerts.map((event) => (
                  <li className="alert-row evaluated-alert-row" key={event.id}>
                    <i
                      className={`lamp ${
                        event.workflow_status === "completed"
                          ? "ok"
                          : "warning"
                      }`}
                      aria-hidden="true"
                    />
                    <div className="alert-body">
                      <div className="alert-title">
                        {event.rule_name || event.message}
                      </div>
                      {event.rule_name && (
                        <div className="alert-msg">{event.message}</div>
                      )}
                      <div className="alert-meta">
                        {event.asset_id != null ? (
                          <Link
                            to={`/assets/${event.asset_id}`}
                            state={
                              event.metadata?.maintenance_schedule_id
                                ? { activeTab: "logbook" }
                                : undefined
                            }
                          >
                            {event.asset_name ||
                              assetName.get(event.asset_id) ||
                              `Asset ${event.asset_id}`}
                          </Link>
                        ) : (
                          <span>{event.asset_name || "System"}</span>
                        )}
                        <span title={new Date(event.occurred_at).toLocaleString()}>
                          {formatTime(event.occurred_at)}
                        </span>
                        {event.metadata?.completed_by && (
                          <span>
                            Completed by {event.metadata.completed_by}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="alert-actions">
                      <span
                        className={`alert-status ${
                          event.workflow_status === "completed"
                            ? "alert-status--completed"
                            : "alert-status--evaluated"
                        }`}
                      >
                        {event.workflow_status === "completed"
                          ? "Completed"
                          : "Evaluated"}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
        </section>

        <section className="panel home-rules-panel">
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
      {alertAction && (
        <Modal
          title={
            alertAction.action === "acknowledge"
              ? "Acknowledge alert"
              : "Complete alert"
          }
          onClose={() => {
            if (busyId === null) setAlertAction(null);
          }}
        >
          <p>{alertAction.action === "acknowledge"
            ? "Have you successfully handled this alert?"
            : "Are you sure you want to mark this item as completed?"}</p>
          {ackError && (
            <p className="notice error" role="alert">{ackError}</p>
          )}
          <div className="modal-actions">
            <button
              type="button"
              className="btn-outline"
              disabled={busyId !== null}
              onClick={() => setAlertAction(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={busyId !== null}
              onClick={
                alertAction.action === "acknowledge"
                  ? acknowledgeAlert
                  : completeAlert
              }
            >
              {busyId === alertAction.alert.id ? "Saving…" : "Yes"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
