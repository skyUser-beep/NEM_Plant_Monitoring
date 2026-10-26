import React, { useCallback, useEffect, useState } from "react";
import { api } from "../../../services/api.js";
import { useAuth } from "../../auth/AuthContext.jsx";
import { EmptyState, Modal } from "../../../components/common/UI.jsx";
import { formatTime } from "../../../utils/format.js";

function todayDateInput() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function displayDate(value) {
  if (!value) return "—";
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

export default function CurrentMaintenanceCards({
  assetId,
  onChanged,
  onCompleted,
  onCompletedRecordsCount,
  showCompleted = false,
}) {
  const { user } = useAuth();
  const canManageMaintenance = ["Administrator", "Supervisor"].includes(user?.role);
  const canOperateDueMaintenance = user?.role === "Operator";
  const [records, setRecords] = useState([]);
  const [completedRecords, setCompletedRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [startingRecordId, setStartingRecordId] = useState(null);
  const [completingRecordId, setCompletingRecordId] = useState(null);
  const [error, setError] = useState("");
  const [selectedRecord, setSelectedRecord] = useState(null);

  const loadCurrentMaintenance = useCallback(async () => {
    setError("");
    try {
      const [schedules, maintenanceRecords] = await Promise.all([
        api.getAll(`/maintenance/schedules?asset_id=${assetId}`),
        api.getAll(`/maintenance?asset_id=${assetId}&include_archived=true`),
      ]);
      const recordsById = new Map(
        maintenanceRecords.map((record) => [record.id, record])
      );
      const today = todayDateInput();
      const completedScheduledRecords = maintenanceRecords.filter(
        (record) =>
          record.schedule_id != null && record.status === "completed"
      );
      setCompletedRecords(completedScheduledRecords);
      onCompletedRecordsCount?.(completedScheduledRecords.length);
      setRecords(
        schedules
          .filter(
            (schedule) =>
              schedule.status === "active" &&
              schedule.approval_status !== "pending"
          )
          .map((schedule) => recordsById.get(schedule.current_occurrence_id))
          .filter(
            (record) =>
              record &&
              (record.status === "in_progress" ||
                (record.status === "planned" &&
                  record.planned_due_date <= today))
          )
      );
    } catch (loadError) {
      setError(loadError.message || "Could not load current maintenance.");
    } finally {
      setLoading(false);
    }
  }, [assetId, onCompletedRecordsCount]);

  useEffect(() => {
    loadCurrentMaintenance();
  }, [loadCurrentMaintenance]);

  const startMaintenance = async (record) => {
    if (
      !canManageMaintenance &&
      !(canOperateDueMaintenance && record.schedule_id != null &&
        record.planned_due_date <= todayDateInput())
    ) return;
    if (startingRecordId !== null) return;
    setStartingRecordId(record.id);
    setError("");
    try {
      await api.post(`/maintenance/${record.id}/start`);
      await Promise.all([
        loadCurrentMaintenance(),
        Promise.resolve(onChanged?.()),
      ]);
      onCompleted?.();
    } catch (startError) {
      setError(startError.message || "Could not start maintenance.");
    } finally {
      setStartingRecordId(null);
    }
  };

  const completeMaintenance = async (record) => {
    if (
      !canManageMaintenance &&
      !(canOperateDueMaintenance && record.schedule_id != null &&
        record.planned_due_date <= todayDateInput())
    ) return;
    if (completingRecordId !== null) return;
    setCompletingRecordId(record.id);
    setError("");
    try {
      await api.post(`/maintenance/${record.id}/complete`);
      setSelectedRecord(null);
      await Promise.all([
        loadCurrentMaintenance(),
        Promise.resolve(onChanged?.()),
      ]);
    } catch (completeError) {
      setError(completeError.message || "Could not complete maintenance.");
    } finally {
      setCompletingRecordId(null);
    }
  };

  if (loading && records.length === 0) return null;

  const displayedRecords = showCompleted ? completedRecords : records;

  return (
    <>
      {showCompleted && (
        <h3 className="current-maintenance-heading">Completed maintenance</h3>
      )}
      {error && <p className="notice error" role="alert">{error}</p>}
      {showCompleted && displayedRecords.length === 0 ? (
        error ? null : (
          <EmptyState
            art={false}
            title="No completed scheduled maintenance"
            lines={["Completed scheduled maintenance will appear here."]}
          />
        )
      ) : (
      <div className="rule-list current-maintenance-list">
        {displayedRecords.map((record) => {
          const inProgress = record.status === "in_progress";
          const completed = record.status === "completed";
          const overdue =
            !completed &&
            record.status === "planned" &&
            record.planned_due_date < todayDateInput();
          return (
            <article
              className={`rule-card rule-row current-maintenance-card ${completed ? "completed" : inProgress ? "in-progress" : "due"}`}
              key={record.id}
            >
              <span className={`sev ${completed ? "ok" : "warning"}`} aria-hidden="true" />
              <div className="rule-name rule-card-main">
                <strong>{record.title}</strong>
                <small className="rule-context">
                  {record.maintenance_type || "Maintenance"} · {record.priority || "medium"} priority
                </small>
              </div>
              <div className="rule-evaluation">
                <span className="badge">
                  {completed
                    ? "Completed"
                    : inProgress
                      ? "In progress"
                      : overdue
                        ? "Overdue"
                        : "Due today"}
                </span>
                <small>
                  {displayDate(record.planned_due_date)}
                  {record.assigned_technician
                    ? ` · ${record.assigned_technician}`
                    : ""}
                </small>
              </div>
              <div className="rule-card-actions current-maintenance-actions">
                {inProgress || completed ? (
                  <button
                    type="button"
                    className="btn-outline"
                    onClick={() => setSelectedRecord(record)}
                  >
                    Open maintenance
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={() => startMaintenance(record)}
                    disabled={
                      startingRecordId !== null ||
                      (!canManageMaintenance &&
                        !(canOperateDueMaintenance &&
                          record.schedule_id != null &&
                          record.planned_due_date <= todayDateInput()))
                    }
                    title={
                      !canManageMaintenance &&
                      !(canOperateDueMaintenance &&
                        record.schedule_id != null &&
                        record.planned_due_date <= todayDateInput())
                        ? "Operators can start scheduled maintenance due today or overdue."
                        : undefined
                    }
                  >
                    {startingRecordId === record.id ? "Starting…" : "Start"}
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
      )}
      {selectedRecord && (
        <Modal
          title="Maintenance details"
          onClose={() => setSelectedRecord(null)}
          wide
        >
          <dl className="maintenance-details">
            <dt>Title</dt><dd>{selectedRecord.title}</dd>
            <dt>Type / status / priority</dt>
            <dd>
              {selectedRecord.maintenance_type} /{" "}
              {String(selectedRecord.status || "").replaceAll("_", " ")} /{" "}
              {selectedRecord.priority}
            </dd>
            <dt>Due date</dt><dd>{displayDate(selectedRecord.planned_due_date)}</dd>
            <dt>Planned start / end</dt>
            <dd>
              {formatTime(selectedRecord.planned_start_at)} –{" "}
              {formatTime(selectedRecord.planned_end_at)}
            </dd>
            <dt>Actual start / completion</dt>
            <dd>
              {formatTime(selectedRecord.actual_started_at)} –{" "}
              {formatTime(selectedRecord.actual_completed_at)}
            </dd>
            <dt>Assigned technician</dt>
            <dd>{selectedRecord.assigned_technician || "—"}</dd>
            <dt>Description / work details</dt>
            <dd>{selectedRecord.notes || "No work details provided."}</dd>
          </dl>
          <div className="modal-actions">
            {selectedRecord.status === "in_progress" && (
              <button
                type="button"
                className="btn-primary"
                onClick={() => completeMaintenance(selectedRecord)}
                disabled={
                  completingRecordId !== null ||
                  (!canManageMaintenance &&
                    !(canOperateDueMaintenance &&
                      selectedRecord.schedule_id != null &&
                      selectedRecord.planned_due_date <= todayDateInput()))
                }
                title={
                  !canManageMaintenance &&
                  !(canOperateDueMaintenance &&
                    selectedRecord.schedule_id != null &&
                    selectedRecord.planned_due_date <= todayDateInput())
                    ? "Operators can complete scheduled maintenance due today or overdue."
                    : undefined
                }
              >
                {completingRecordId === selectedRecord.id
                  ? "Completing…"
                  : "Complete maintenance"}
              </button>
            )}
            <button
              type="button"
              className="btn-outline"
              onClick={() => setSelectedRecord(null)}
              disabled={completingRecordId !== null}
            >
              Close
            </button>
          </div>
          {error && <p className="notice error" role="alert">{error}</p>}
        </Modal>
      )}
    </>
  );
}
