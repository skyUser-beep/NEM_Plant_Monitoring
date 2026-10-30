import React from "react";
import { formatTime } from "../../../utils/format.js";

function displayDate(value) {
  if (!value) return "—";
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

function actualDuration(record, now) {
  if (!record.actual_started_at) return "—";
  const endTime = record.actual_completed_at
    ? new Date(record.actual_completed_at).getTime()
    : now;
  const seconds =
    (endTime - new Date(record.actual_started_at).getTime()) / 1000;
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

export default function MaintenanceDetails({ record, now = Date.now() }) {
  if (!record) return null;

  const status = record.status || "planned";
  const workDetails = [
    ["Notes", record.notes],
    ["Completion notes", record.completion_notes],
    ["Parts used", record.parts_used],
  ].filter(([, value]) => value);

  return (
    <div className="maintenance-detail-view">
      <div className="maintenance-detail-hero">
        <div className="maintenance-detail-symbol" aria-hidden="true">
          <span>⚙</span>
        </div>
        <div className="maintenance-detail-hero-copy">
          <span className="maintenance-detail-eyebrow">MAINTENANCE RECORD</span>
          <h3>{record.title || record.summary || "Untitled maintenance"}</h3>
          <p>
            {String(record.maintenance_type || "maintenance").replaceAll("_", " ")}
            {" · "}
            {record.priority || "medium"} priority
          </p>
        </div>
        <span
          className={`maintenance-detail-status maintenance-detail-status--${String(
            status
          ).replaceAll("_", "-")}`}
        >
          {String(status).replaceAll("_", " ")}
        </span>
      </div>

      <div className="maintenance-detail-content">
        <section className="maintenance-detail-section">
          <h4>GENERAL INFORMATION</h4>
          <div className="maintenance-detail-grid">
            <div className="maintenance-detail-field">
              <span>Maintenance type</span>
              <strong>{record.maintenance_type || "—"}</strong>
            </div>
            <div className="maintenance-detail-field">
              <span>Priority</span>
              <strong>{record.priority || "medium"}</strong>
            </div>
            <div className="maintenance-detail-field">
              <span>Assigned technician</span>
              <strong>{record.assigned_technician || record.performed_by || "—"}</strong>
            </div>
            <div className="maintenance-detail-field">
              <span>Due date</span>
              <strong>
                {displayDate(
                  record.planned_due_date || record.planned_start_at?.slice(0, 10)
                )}
              </strong>
            </div>
            <div className="maintenance-detail-field">
              <span>Actual duration</span>
              <strong>{actualDuration(record, now)}</strong>
            </div>
          </div>
        </section>

        <section className="maintenance-detail-section">
          <h4>SCHEDULE &amp; EXECUTION</h4>
          <div className="maintenance-detail-timeline">
            <div className="maintenance-detail-time">
              <span className="maintenance-detail-time-dot planned" />
              <div>
                <span>Planned start</span>
                <strong>{formatTime(record.planned_start_at)}</strong>
              </div>
            </div>
            <div className="maintenance-detail-time">
              <span className="maintenance-detail-time-dot planned" />
              <div>
                <span>Planned end</span>
                <strong>{formatTime(record.planned_end_at)}</strong>
              </div>
            </div>
            <div className="maintenance-detail-time">
              <span className="maintenance-detail-time-dot actual" />
              <div>
                <span>Actual start</span>
                <strong>{formatTime(record.actual_started_at)}</strong>
              </div>
            </div>
            <div className="maintenance-detail-time">
              <span className="maintenance-detail-time-dot actual" />
              <div>
                <span>Actual completion</span>
                <strong>{formatTime(record.actual_completed_at)}</strong>
              </div>
            </div>
          </div>
        </section>

        <section className="maintenance-detail-section">
          <h4>WORK DETAILS</h4>
          <div className="maintenance-detail-notes">
            {workDetails.length ? (
              workDetails.map(([label, value]) => (
                <p key={label}>
                  <strong>{label}:</strong> {value}
                </p>
              ))
            ) : (
              <p>No work details provided.</p>
            )}
            {Array.isArray(record.checklist) && record.checklist.length > 0 && (
              <ul>
                {record.checklist.map((item, index) => (
                  <li key={`${item.item}-${index}`}>
                    {item.completed ? "Complete" : "Incomplete"}: {item.item}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
