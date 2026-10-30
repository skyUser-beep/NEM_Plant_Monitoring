import React, { useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { api } from "../../../services/api.js";
import { EmptyState, StatusBadge } from "../../../components/common/UI.jsx";
import { BackIcon } from "../../../components/common/Icons.jsx";
import { returnToNavigationOrigin } from "../../../utils/navigation.js";

export default function AlertRules() {
  const { kind } = useParams();
  const nav = useNavigate();
  const location = useLocation();
  const returnToHome = () =>
    returnToNavigationOrigin(nav, location.state?.from, "/");
  const [rules, setRules] = useState(null);
  const [error, setError] = useState("");
  const lifecycleStatuses = ["activated", "suspended", "deactivated", "completed"];
  const lifecycleStatus = lifecycleStatuses.includes(kind)
    ? kind === "activated"
      ? "in_progress"
      : kind
    : null;
  const heading = lifecycleStatus
    ? `${kind === "activated" ? "Activated" : kind[0].toUpperCase() + kind.slice(1)} rules`
    : `Rules in ${kind} status`;

  useEffect(() => {
    let alive = true;
    setRules(null);
    setError("");
    api
      .get(
        lifecycleStatus
          ? `/rules/lifecycle/${lifecycleStatus}`
          : `/rules/status/${kind}`
      )
      .then((items) => alive && setRules(Array.isArray(items) ? items : []))
      .catch((err) => alive && setError(err.message));
    return () => {
      alive = false;
    };
  }, [kind, lifecycleStatus]);

  return (
    <div>
      <button className="link-btn" onClick={returnToHome}>
        <BackIcon size={14} /> Back
      </button>
      <h1 className="page-title">{heading}</h1>
      <div className="panel">
        {error ? (
          <div className="notice error" role="alert">{error}</div>
        ) : !rules ? (
          <div className="loading" role="status">Loading…</div>
        ) : rules.length === 0 ? (
          <EmptyState
            title={
              lifecycleStatus
                ? `No ${kind} rules`
                : `No rules are in ${kind} status`
            }
            lines={[
              lifecycleStatus
                ? `Rules with the ${kind} lifecycle status appear here.`
                : "Only enabled rules that have been evaluated appear here.",
            ]}
          />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Rule</th>
                <th>Asset</th>
                <th>Configured severity</th>
                {lifecycleStatus && <th>Lifecycle</th>}
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr
                  key={r.id}
                  className={r.asset_id ? "clickable" : ""}
                  onClick={() => r.asset_id && nav(`/assets/${r.asset_id}`)}
                >
                  <td>{r.name}</td>
                  <td>{r.asset_name || <span className="muted">-</span>}</td>
                  <td className="cap">{r.severity}</td>
                  {lifecycleStatus && (
                    <td className="cap">
                      {r.lifecycle_status === "in_progress"
                        ? "Activated · In progress"
                        : r.lifecycle_status}
                    </td>
                  )}
                  <td><StatusBadge status={r.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
