import React, { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Eye, Pencil, Trash2 } from "lucide-react";
import { api } from "../../../services/api.js";
import { useAuth } from "../../auth/AuthContext.jsx";
import { captureNavigationOrigin } from "../../../utils/navigation.js";
import {
  EmptyState,
  FloatingMenu,
  Modal,
  useConfirmation,
} from "../../../components/common/UI.jsx";
import { formatTime } from "../../../utils/format.js";
import MaintenanceDetails from "./MaintenanceDetails.jsx";
import { DotsIcon } from "../../../components/common/Icons.jsx";
import "./MaintenancePanel.css";

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
  refreshKey = 0,
  onChanged,
  onCompleted,
  onCompletedRecordsCount,
  showCompleted = false,
  navigationState,
}) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const confirm = useConfirmation();
  const isAdministrator = user?.role === "Administrator";
  const canManageMaintenance = ["Administrator", "Supervisor"].includes(user?.role);
  const canOperateDueMaintenance = user?.role === "Operator";
  const [records, setRecords] = useState([]);
  const [completedRecords, setCompletedRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [startingRecordId, setStartingRecordId] = useState(null);
  const [completingRecordId, setCompletingRecordId] = useState(null);
  const [deletingRecordId, setDeletingRecordId] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedRecord, setSelectedRecord] = useState(null);
  const [editingRecordId, setEditingRecordId] = useState(null);
  const [actionMenuRecordId, setActionMenuRecordId] = useState(null);
  const actionMenuTriggerRef = useRef(null);
  const lastLoadedDate = useRef("");
  const loadingRef = useRef(false);
  const busy =
    startingRecordId !== null ||
    completingRecordId !== null ||
    deletingRecordId !== null;

const openEdit = (record) => {
  if (
    !canManageMaintenance ||
    record.status === "in_progress" ||
    record.status === "completed"
  ) return;

  setEditingRecordId(record.id);

  if (record.schedule_id) {
    navigate(
      `/assets/${assetId}/maintenance/schedules/${record.schedule_id}/edit`,
      {
        state: {
          from: captureNavigationOrigin(location, {
            ...(navigationState || location.state),
            activeTab:
              navigationState?.activeTab || location.state?.activeTab || "status",
          }),
          maintenanceRecord: record,
        },
      }
    );
    return;
  }

  navigate(
    `/assets/${assetId}/maintenance/${record.id}/edit`,
    {
      state: {
        from: captureNavigationOrigin(location, {
          ...(navigationState || location.state),
          activeTab:
            navigationState?.activeTab || location.state?.activeTab || "status",
        }),
        maintenanceRecord: record,
      },
    }
  );
};

  const permanentlyDeleteRecord = async (record) => {
    if (!isAdministrator || busy || record.status === "in_progress") return;
    const scheduled =
      Boolean(record.schedule_id) &&
      !(record.status === "completed" && record.archived_at);
    const plannedDate = record.planned_start_at
      ? formatTime(record.planned_start_at)
      : null;
    const confirmation = scheduled
      ? `Delete the entire schedule "${record.title}"${plannedDate ? `, scheduled for ${plannedDate}` : ""}, including its linked maintenance entries?`
      : `Permanently delete maintenance "${record.title}"${plannedDate ? `, scheduled for ${plannedDate}` : ""}?`;
    if (
      !(await confirm(confirmation, {
        title: scheduled ? "Delete maintenance schedule" : "Delete maintenance",
        confirmLabel: "Delete",
        destructive: true,
      }))
    ) return;
    if (
      (scheduled ||
        (record.planned_start_at &&
          new Date(record.planned_start_at) > new Date())) &&
      !(await confirm(
        `Confirm again: permanently delete "${record.title}"${plannedDate ? ` scheduled for ${plannedDate}` : ""}? This cannot be undone.`,
        {
          title: "Confirm permanent deletion",
          confirmLabel: "Delete permanently",
          destructive: true,
        }
      ))
    ) {
      return;
    }

    setDeletingRecordId(record.id);
    setError("");
    setNotice("");
    try {
      await api.del(`/maintenance/${record.id}/permanent`);
      setSelectedRecord(null);
      setNotice("Maintenance was permanently deleted.");
      await Promise.all([
        loadCurrentMaintenance(),
        Promise.resolve(onChanged?.()),
      ]);
    } catch (deleteError) {
      setError(deleteError.message || "Could not permanently delete maintenance.");
    } finally {
      setDeletingRecordId(null);
    }
  };

  const loadCurrentMaintenance = useCallback(async () => {
    if (loadingRef.current) return false;
    loadingRef.current = true;
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
      lastLoadedDate.current = today;
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
      return true;
    } catch (loadError) {
      setError(loadError.message || "Could not load current maintenance.");
      return false;
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [assetId, onCompletedRecordsCount]);

  useEffect(() => {
    loadCurrentMaintenance();
  }, [loadCurrentMaintenance, refreshKey]);

  useEffect(() => {
    if (actionMenuRecordId === null) return undefined;

    const handlePointerDown = (event) => {
      if (!(event.target instanceof Element)) return;
      if (
        actionMenuTriggerRef.current?.contains(event.target) ||
        event.target.closest("[data-current-maintenance-action-menu]")
      ) {
        return;
      }
      setActionMenuRecordId(null);
    };
    const handleKeyDown = (event) => {
      if (event.key !== "Escape") return;
      setActionMenuRecordId(null);
      actionMenuTriggerRef.current?.focus();
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [actionMenuRecordId]);

  useEffect(() => {
    let midnightTimer;
    let dateRefreshInProgress = false;
    let disposed = false;

    const refreshIfDateChanged = async () => {
      if (
        disposed ||
        document.visibilityState !== "visible" ||
        todayDateInput() === lastLoadedDate.current ||
        dateRefreshInProgress
      ) {
        return;
      }

      dateRefreshInProgress = true;
      try {
        await loadCurrentMaintenance();
      } finally {
        dateRefreshInProgress = false;
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
      midnightTimer = window.setTimeout(async () => {
        await refreshIfDateChanged();
        if (!disposed) scheduleMidnightRefresh();
      }, Math.max(0, nextMidnight.getTime() - now.getTime()) + 100);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refreshIfDateChanged();
      }
      scheduleMidnightRefresh();
    };

    scheduleMidnightRefresh();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      disposed = true;
      window.clearTimeout(midnightTimer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
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
      {notice && (
        <div className="banner success" role="status">
          <p>{notice}</p>
        </div>
      )}
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
                {!inProgress && !completed && (
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
                <div className="current-maintenance-action-menu">
                    <button
                      type="button"
                      ref={actionMenuRecordId === record.id ? actionMenuTriggerRef : null}
                      className="icon-outline sm maintenance-actions-trigger"
                      title={`Maintenance actions for ${record.title}`}
                      aria-label={`Maintenance actions for ${record.title}`}
                      aria-haspopup="menu"
                      aria-expanded={actionMenuRecordId === record.id}
                      disabled={busy}
                      onClick={() =>
                        setActionMenuRecordId((current) =>
                          current === record.id ? null : record.id
                        )
                      }
                    >
                      <DotsIcon size={17} />
                    </button>
                    {actionMenuRecordId === record.id && (
                      <FloatingMenu
                        align="right"
                        role="menu"
                        data-current-maintenance-action-menu=""
                        data-maintenance-action-menu=""
                      >
                        <button
                          type="button"
                          className="maintenance-action-menu-item"
                          role="menuitem"
                          onClick={() => {
                            setActionMenuRecordId(null);
                            setSelectedRecord(record);
                          }}
                        >
                          <Eye size={16} aria-hidden="true" />
                          <span>View maintenance</span>
                        </button>
                        <button
                          type="button"
                          className="maintenance-action-menu-item maintenance-action-menu-item--edit"
                          role="menuitem"
                          onClick={() => {
                            setActionMenuRecordId(null);
                            openEdit(record);
                          }}
                          disabled={
                            !canManageMaintenance ||
                            inProgress ||
                            completed ||
                            busy
                          }
                          title={
                            inProgress
                              ? "In-progress maintenance cannot be edited."
                              : completed
                                ? "Completed maintenance cannot be edited."
                                : !canManageMaintenance
                                  ? "You do not have permission to edit maintenance records."
                                  : undefined
                          }
                        >
                          <Pencil size={16} aria-hidden="true" />
                          <span>Edit maintenance</span>
                        </button>
                        {isAdministrator && (
                          <button
                            type="button"
                            className="maintenance-action-menu-item maintenance-action-menu-item--delete"
                            role="menuitem"
                            onClick={() => {
                              setActionMenuRecordId(null);
                              permanentlyDeleteRecord(record);
                            }}
                            disabled={busy || inProgress}
                            title={
                              inProgress
                                ? "In-progress maintenance cannot be deleted."
                                : "Permanently delete maintenance"
                            }
                          >
                            <Trash2 size={16} aria-hidden="true" />
                            <span>Delete maintenance</span>
                          </button>
                        )}
                      </FloatingMenu>
                    )}
                </div>
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
          <MaintenanceDetails record={selectedRecord} now={clockNow} />
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
              onClick={() => openEdit(selectedRecord)}
              disabled={
                busy ||
                !canManageMaintenance ||
                selectedRecord.status === "in_progress" ||
                selectedRecord.status === "completed"
              }
              title={
                selectedRecord.status === "in_progress"
                  ? "In-progress maintenance cannot be edited."
                  : selectedRecord.status === "completed"
                    ? "Completed maintenance cannot be edited."
                    : !canManageMaintenance
                      ? "You do not have permission to edit maintenance records."
                      : undefined
              }
            >
              <Pencil size={13} /> Edit
            </button>
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
