import React, { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../../services/api.js";
import { formatDuration, timeAgo } from "../../../utils/format.js";
import "../styles/Plc.css";
document.documentElement.dataset.theme

const Svg = ({ children, size = 22 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
const IconChip = (p) => <Svg {...p}><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" /></Svg>;
const IconPulse = (p) => <Svg {...p}><path d="M3 12h4l2.5-7 5 14 2.5-7h4" /></Svg>;
const IconShield = (p) => <Svg {...p}><path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6z" /><path d="M9 12l2.2 2.2L15.5 10" /></Svg>;
const IconDownload = (p) => <Svg {...p}><path d="M12 3v12M7 10l5 5 5-5M4 20h16" /></Svg>;
const IconEmpty = (p) => <Svg size={34} {...p}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18M8 15h3" /></Svg>;
const Spinner = () => <span className="spin" aria-hidden="true" />;

function useAppTheme() {
  const [light, setLight] = useState(
    () => document.documentElement.dataset.theme !== "dark"
  );

  useEffect(() => {
    const updateTheme = () => {
      setLight(document.documentElement.dataset.theme !== "dark");
    };

    updateTheme();

    const observer = new MutationObserver(updateTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    return () => observer.disconnect();
  }, []);

  return light;
}

const percent = (value, limit) => (limit ? Math.min(100, Math.round((value / limit) * 100)) : null);
const barTone = (pct) => (pct >= 100 ? " bad" : pct >= 80 ? " warn" : "");

export default function Plc() {
  const light = useAppTheme();
  const [assets, setAssets] = useState([]);
  const [variables, setVariables] = useState([]);
  const [assetId, setAssetId] = useState("");
  const [variableId, setVariableId] = useState("");
  const [nodeId, setNodeId] = useState("");
  const [sourceId, setSourceId] = useState("opcua");

  const [connection, setConnection] = useState({
    state: "untested",
    message: "",
  });

  const [reading, setReading] = useState("");
  const [readError, setReadError] = useState(false);
  const [busy, setBusy] = useState("");

  const [monitoring, setMonitoring] = useState(null);
  const [monitoringLoading, setMonitoringLoading] = useState(true);
  const [monitoringError, setMonitoringError] = useState("");
  const monitoringRequest = useRef(null);
  const monitoringMounted = useRef(false);

  const [latestReadings, setLatestReadings] = useState([]);
  const [latestError, setLatestError] = useState("");
  const [latestLoading, setLatestLoading] = useState(true);


  const loadLatestReadings = useCallback(async () => {
    try {
      const result = await api.getAll("/readings/latest?limit=100");
      const items = Array.isArray(result) ? result : [];
      const newestByVariable = new Map();

      for (const item of items) {
        const key = `${item.asset_id}:${item.variable_id}`;
        const previous = newestByVariable.get(key);

        if (
          !previous ||
          new Date(item.recorded_at).getTime() >
            new Date(previous.recorded_at).getTime()
        ) {
          newestByVariable.set(key, item);
        }
      }

      const newest = [...newestByVariable.values()].sort(
        (a, b) =>
          new Date(b.recorded_at).getTime() -
          new Date(a.recorded_at).getTime()
      );

      setLatestReadings(newest);
      setLatestError("");
    } catch (error) {
      setLatestError(
        error.message || "Could not load latest readings."
      );
    } finally {
      setLatestLoading(false);
    }
  }, []);


  const loadMonitoringStatus = useCallback(async () => {
    if (monitoringRequest.current) return monitoringRequest.current;

    let request;
    request = (async () => {
      try {
        const result = await api.get("/plc/status");
        if (monitoringMounted.current) {
          setMonitoring(result);
          setMonitoringError("");
        }
      } catch (error) {
        if (monitoringMounted.current) {
          setMonitoringError(
            error.message || "Could not load PLC status."
          );
        }
      } finally {
        if (monitoringMounted.current) {
          setMonitoringLoading(false);
        }
        if (monitoringRequest.current === request) {
          monitoringRequest.current = null;
        }
      }
    })();

    monitoringRequest.current = request;
    return request;
  }, []);

  useEffect(() => {
    monitoringMounted.current = true;
    return () => {
      monitoringMounted.current = false;
    };
  }, []);

  // Initial data load.
  useEffect(() => {
    let active = true;

    const loadInitialData = async () => {
      await Promise.all([
        loadLatestReadings(),
        loadMonitoringStatus(),
      ]);
    };

    loadInitialData();

    api
      .getAll("/assets?is_active=true")
      .then((items) => {
        if (!active) return;

        const list = Array.isArray(items) ? items : [];
        setAssets(list);

        if (list.length) {
          setAssetId(String(list[0].id));
        }
      })
      .catch((error) => {
        if (active) {
          setConnection({
            state: "error",
            message: error.message || "Could not load assets.",
          });
        }
      });

    return () => {
      active = false;
    };
  }, [loadLatestReadings, loadMonitoringStatus]);


  useEffect(() => {
    let active = true;
    let timeoutId;

    const pollMonitoringStatus = async () => {
      const requestStartedAt = Date.now();
      await loadMonitoringStatus();
      if (active) {
        const elapsed = Date.now() - requestStartedAt;
        timeoutId = window.setTimeout(
          pollMonitoringStatus,
          Math.max(0, 1500 - elapsed)
        );
      }
    };

    pollMonitoringStatus();

    return () => {
      active = false;
      window.clearTimeout(timeoutId);
    };
  }, [loadMonitoringStatus]);

 
  useEffect(() => {
    let active = true;

    setVariableId("");

    if (!assetId) {
      setVariables([]);
      return () => {
        active = false;
      };
    }

    api
      .getAll(`/assets/${assetId}/variables?is_active=true`)
      .then((items) => {
        if (!active) return;

        const list = Array.isArray(items) ? items : [];
        setVariables(list);

        if (list.length) {
          setVariableId(String(list[0].id));
        }
      })
      .catch((error) => {
        if (!active) return;

        setVariables([]);
        setReading(
          `Could not load variables: ${error.message}`
        );
        setReadError(true);
      });

    return () => {
      active = false;
    };
  }, [assetId]);

  const testConnection = async () => {
    setBusy("test");
    setConnection({
      state: "testing",
      message: "Testing unencrypted OPC UA connection…",
    });

    try {
      const result = await api.get("/plc/test");

      setConnection({
        state: "connected",
        message: `Connection succeeded. Server time: ${
          result.server_time || "available"
        }.`,
      });
    } catch (error) {
      setConnection({
        state: "error",
        message:
          error.message || "OPC UA connection test failed.",
      });
    } finally {
      setBusy("");
    }
  };

  const readNode = async (event) => {
    event.preventDefault();

    setBusy("read");
    setReading("Reading this NodeId once…");
    setReadError(false);

    try {
      const result = await api.post("/plc/read", {
        node_id: nodeId.trim(),
        asset_id: Number(assetId),
        variable_id: Number(variableId),
        source_id: sourceId.trim() || "opcua",
      });

      const recordedAt = result.reading?.recorded_at
        ? new Date(
            result.reading.recorded_at
          ).toLocaleString()
        : "time unavailable";

      setReading(
        `Read and saved: ${JSON.stringify(
          result.value
        )} at ${recordedAt}`
      );

     
      await Promise.all([
        loadLatestReadings(),
        loadMonitoringStatus(),
      ]);
    } catch (error) {
      setReading(`PLC read failed: ${error.message}`);
      setReadError(true);
    } finally {
      setBusy("");
    }
  };

  const conn = monitoring?.connection;

  const connText = !conn
    ? ""
    : conn.state === "disabled"
      ? "Continuous monitoring is not configured. Set OPCUA_MACHINE_MAPPINGS on the backend."
      : conn.connected
        ? "OPC UA subscription connected."
        : conn.state === "connecting"
          ? "Connecting to the OPC UA subscription…"
          : conn.state === "standby"
            ? "This backend instance is waiting for the active collector."
            : `OPC UA subscription disconnected${
                conn.last_error ? `: ${conn.last_error}` : "."
              }`;

  const formatValue = (value) => {
    if (value === null || value === undefined) return "—";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  };

  const formatTimestamp = (timestamp) => {
    if (!timestamp) return "—";

    const date = new Date(timestamp);

    return Number.isNaN(date.getTime())
      ? "Invalid time"
      : date.toLocaleString();
  };

  
  const pill = !conn
    ? { tone: "", text: monitoringError ? "Status unavailable" : "Checking…" }
    : conn.connected
      ? { tone: "ok", text: "Live" }
      : conn.state === "disabled"
        ? { tone: "", text: "Not configured" }
        : conn.state === "connecting" || conn.state === "standby"
          ? { tone: "warn", text: conn.state === "standby" ? "Standby" : "Connecting" }
          : { tone: "bad", text: "Disconnected" };

  const readOk = reading.startsWith("Read and saved");

  return (
    <div className="plc-page">
      <div className="page-head">
        <h1 className="page-title">PLC / OPC UA</h1>
      </div>

      <p className="muted lede">
        Monitor PLC values. This development connection does not encrypt OPC UA
        traffic; use it only on a trusted test network.
      </p>

      <section className="panel plc-panel wide">
        <div className="panel-head">
          <h2>Latest PLC readings</h2>
          <button
            type="button"
            className="btn-outline"
            disabled={latestLoading}
            onClick={loadLatestReadings}
          >
            Refresh readings
          </button>
        </div>

        <p className="muted">
          Latest values saved in the backend database. This table updates when
          the page opens, when you read a node, or when you refresh manually.
        </p>

        {latestLoading && (
          <p className="muted" role="status">
            Loading latest readings…
          </p>
        )}

        {latestError && (
          <p className="notice error" role="alert">
            Could not load latest readings: {latestError}
          </p>
        )}

        {!latestLoading &&
          !latestError &&
          latestReadings.length === 0 && (
            <p className="muted">
              No readings have been saved yet. Use “Read node and save” to test
              a node, or configure continuous subscriptions in the backend.
            </p>
          )}

        {latestReadings.length > 0 && (
         <div className="plc-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Asset ID</th>
                  <th>Variable ID</th>
                  <th>Value</th>
                  <th>Source</th>
                  <th>Last updated</th>
                  <th>NodeId</th>
                </tr>
              </thead>
              <tbody>
                {latestReadings.map((item) => (
                  <tr key={`${item.asset_id}-${item.variable_id}`}>
                    <td>{item.asset_id}</td>
                    <td>{item.variable_id}</td>
                    <td>
                      <strong>{formatValue(item.value)}</strong>
                    </td>
                    <td>{item.source_id || "—"}</td>
                    <td>
                      <span title={formatTimestamp(item.recorded_at)}>
                        {item.recorded_at
                          ? timeAgo(item.recorded_at)
                          : "—"}
                      </span>
                      <br />
                      <small>
                        {formatTimestamp(item.recorded_at)}
                      </small>
                    </td>
                    <td>
                      <code>
                        {item.metadata?.node_id || "Not recorded"}
                      </code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {}
      <section className="panel plc-panel wide">
        <div className="panel-head">
          <h2>Continuous machine monitoring</h2>
          <button
            type="button"
            className="btn-outline"
            disabled={monitoringLoading}
            onClick={loadMonitoringStatus}
          >
            Refresh status
          </button>
        </div>

        <p className="muted">
          Monitoring status refreshes automatically every 1.5 seconds.
        </p>

        {monitoringLoading && (
          <p className="muted" role="status">
            Loading PLC monitoring status…
          </p>
        )}

        {monitoringError && (
          <p className="notice error" role="alert">
            Could not refresh PLC status: {monitoringError}
          </p>
        )}

        {!monitoringLoading && monitoring && (
          <>
            {conn && (
              <p
                className={
                  "link-line " +
                  (conn.connected
                    ? "up"
                    : conn.state === "disabled"
                      ? "wait"
                      : "down")
                }
                role="status"
              >
                <i />
                {connText}
              </p>
            )}

            {conn?.stale && conn?.configured && (
              <p className="notice error" role="status">
                PLC data is stale, or no valid subscription notification has
                been received.
              </p>
            )}

            <p className="muted">
              Effective NodeId mappings come from backend
              {" "}OPCUA_MACHINE_MAPPINGS (read-only). Requested publishing
              interval: {conn?.requested_publishing_interval_ms ?? "—"} ms;
              negotiated:{" "}
              {conn?.negotiated_publishing_interval_ms == null
                ? "unavailable"
                : `${conn.negotiated_publishing_interval_ms} ms`}
              . asyncua monitors at a requested 50 ms sampling interval with
              server-default queue size; the server may revise either value.
            </p>

            {monitoring.mappings?.length > 0 && (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Asset</th>
                      <th>Variable</th>
                      <th>Type</th>
                      <th>Configured NodeId</th>
                      <th>Collector role</th>
                      <th>Mapping status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {monitoring.mappings.map((mapping) => {
                      const mappingIsValid = mapping.mapping_valid;
                      const storedNodeDiffers =
                        mapping.variable_opcua_node_id &&
                        mapping.variable_opcua_node_id !== mapping.node_id;
                      return (
                        <tr
                          key={`${mapping.asset_id}-${mapping.variable_id}-${mapping.node_id}`}
                        >
                          <td>
                            {mapping.asset_name || "Missing asset"}
                            {" "}
                            <small>#{mapping.asset_id}</small>
                          </td>
                          <td>
                            {mapping.variable_name || "Missing variable"}
                            {" "}
                            <small>#{mapping.variable_id}</small>
                          </td>
                          <td>{mapping.data_type || "—"}</td>
                          <td><code>{mapping.node_id}</code></td>
                          <td>
                            {mapping.role === "cycle_signal"
                              ? "Cycle signal"
                              : mapping.role === "running_signal"
                                ? "Running signal"
                                : "Ordinary reading"}
                          </td>
                          <td>
                            {!mappingIsValid
                              ? "Invalid or inactive database target"
                              : storedNodeDiffers
                                ? "Warning: variable NodeId differs from collector config"
                                : conn?.connected
                                  ? "Configured; collector connected"
                                  : "Configured; collector disconnected"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {!monitoring.machines?.length ? (
              <p className="muted">
                No machine NodeId mappings are configured.
              </p>
            ) : (
              <div className="machine-cards">
                {monitoring.machines.map((machine) => (
                  <article
                    className="machine-card"
                    key={machine.asset_id}
                  >
                    <header>
                      <h3>
                        {machine.asset_name ||
                          `Asset ${machine.asset_id}`}
                      </h3>

                      <span
                        className={"machine-state " + machine.status}
                      >
                        <i
                          className={
                            "lamp " +
                            (machine.status === "running"
                              ? "ok"
                              : machine.status === "stopped"
                                ? "off"
                                : "warning")
                          }
                        />
                        <span className="cap">
                          {machine.status}
                        </span>
                        {machine.stale && <em>stale data</em>}
                      </span>
                    </header>

                    <div className="machine-figs">
                      <div className="machine-fig">
                        <span>Cycles</span>
                        <b>
                          {machine.cycle_count}
                          {machine.cycle_limit ? (
                            <small> / {machine.cycle_limit}</small>
                          ) : null}
                        </b>
                      </div>

                      <div className="machine-fig">
                        <span>Running time</span>
                        <b>
                          {formatDuration(machine.running_seconds)}
                          {machine.runtime_limit_seconds ? (
                            <small>
                              {" "}
                              /{" "}
                              {formatDuration(
                                machine.runtime_limit_seconds
                              )}
                            </small>
                          ) : null}
                        </b>
                      </div>
                    </div>

                    <p className="muted">
                      Last signal:{" "}
                      {machine.last_seen_at
                        ? `${timeAgo(
                            machine.last_seen_at
                          )} (${formatTimestamp(
                            machine.last_seen_at
                          )})`
                        : "not received"}
                    </p>

                    {machine.alerts?.length > 0 && (
                      <div role="status" className="machine-alerts">
                        <strong>Active alerts</strong>
                        {machine.alerts.map((alert) => (
                          <p
                            className={
                              "notice " +
                              (alert.severity === "alert"
                                ? "error"
                                : "warn")
                            }
                            key={alert.id}
                          >
                            {alert.title}: {alert.message}
                          </p>
                        ))}
                      </div>
                    )}
                  </article>
                ))}
              </div>
            )}
          </>
        )}
      </section>

      <section className="panel plc-panel">
        <h2>Development connection</h2>

        <p className="muted">
          Uses the configured OPC UA endpoint without transport encryption or
          certificates. This client is read-only; only use it on a trusted test
          network.
        </p>

        <button
          className="btn-primary"
          disabled={busy !== ""}
          onClick={testConnection}
        >
          {busy === "test"
            ? "Testing…"
            : "Test connection"}
        </button>

        {connection.message && (
          <p
            className={
              "notice" +
              (connection.state === "error" ? " error" : "")
            }
            role="status"
          >
            {connection.message}
          </p>
        )}
      </section>

      <section className="panel plc-panel">
        <h2>Read and save one value</h2>

        <p className="muted">
          Each submission reads once, saves a reading, and evaluates matching
          monitoring rules. It does not start another collector.
        </p>

        <form className="form" onSubmit={readNode}>
          <label className="field">
            PLC NodeId
            <input
              required
              maxLength={512}
              value={nodeId}
              onChange={(event) => setNodeId(event.target.value)}
              placeholder='ns=3;s="OPC Lab DB"."DoughTemp"'
            />
          </label>

          <label className="field">
            Asset
            <select
              required
              value={assetId}
              onChange={(event) => setAssetId(event.target.value)}
            >
              {assets.map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.name} ({asset.asset_type})
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            Variable
            <select
              required
              value={variableId}
              onChange={(event) => setVariableId(event.target.value)}
              disabled={!variables.length}
            >
              {variables.map((variable) => (
                <option key={variable.id} value={variable.id}>
                  {variable.name}, {variable.data_type}
                  {variable.unit ? ` (${variable.unit})` : ""}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            Source label
            <input
              maxLength={200}
              value={sourceId}
              onChange={(event) => setSourceId(event.target.value)}
            />
          </label>

          <div>
            <button
              className="btn-primary"
              type="submit"
              disabled={
                busy !== "" ||
                !assets.length ||
                !variables.length ||
                !nodeId.trim()
              }
            >
              {busy === "read"
                ? "Reading…"
                : "Read node and save"}
            </button>
          </div>
        </form>

        {reading && (
          <p
            className={
              "notice" + (readError ? " error" : "")
            }
            role="status"
          >
            {reading}
          </p>
        )}
      </section>
    </div>
  );
}