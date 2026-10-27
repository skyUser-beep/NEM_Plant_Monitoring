import React, { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FileText, Timer, Trash2 } from "lucide-react";
import { api } from "../../../services/api.js";
import { useAuth } from "../../auth/AuthContext.jsx";
import {
  EmptyState,
  Modal,
  useConfirmation,
} from "../../../components/common/UI.jsx";
import { formatTime } from "../../../utils/format.js";
import {
  LEGACY_RULE_CHOICES,
  legacyRulePath,
} from "../rules/monitoringRuleFlow.js";
import "./MaintenancePanel.css";

const API_BASE = (import.meta.env.VITE_API_URL || "/api/v1").replace(/\/+$/, "");
const TYPES = ["preventive", "corrective", "inspection", "unplanned"];
const STATUSES = ["planned", "in_progress", "completed", "cancelled"];
const PRIORITIES = ["low", "medium", "high", "critical"];
const RECURRENCE_UNITS = ["days", "weeks", "months", "years"];

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

function localDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function formValues(record) {
  return {
    title: record?.title || "",
    maintenance_type: record?.maintenance_type || "preventive",
    status: record?.status || "planned",
    planned_start_at: localDateTime(record?.planned_start_at),
    planned_end_at: localDateTime(record?.planned_end_at),
    priority: record?.priority || "medium",
    assigned_technician: record?.assigned_technician || "",
    actual_started_at: localDateTime(record?.actual_started_at),
    actual_completed_at: localDateTime(record?.actual_completed_at),
    notes: record?.notes || "",
    completion_notes: record?.completion_notes || "",
    parts_used: record?.parts_used || "",
    checklist: (record?.checklist || []).map((item) => item.item || "").join("\n"),
    next_due_at: localDateTime(record?.next_due_at),
    alert_id: record?.alert_id ? String(record.alert_id) : "",
  };
}

function nullableDate(value) {
  return value ? new Date(value).toISOString() : null;
}

function actualDuration(record, now = Date.now()) {
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

function plannedDurationDays(record) {
  if (!record.planned_start_at || !record.planned_end_at) {
    return "—";
  }

  const start = new Date(record.planned_start_at);
  const end = new Date(record.planned_end_at);

  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    end < start
  ) {
    return "—";
  }

  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  const days = Math.ceil((end - start) / millisecondsPerDay);

  return `${days} ${days === 1 ? "day" : "days"}`;
}

function validateForm(values, requirePlannedDates) {
  const plannedStart = new Date(values.planned_start_at);
  const plannedEnd = new Date(values.planned_end_at);
  if (requirePlannedDates || values.planned_start_at || values.planned_end_at) {
    if (
      !values.planned_start_at ||
      !values.planned_end_at ||
      Number.isNaN(plannedStart.getTime()) ||
      Number.isNaN(plannedEnd.getTime())
    ) {
      return "Planned start and end are required.";
    }
    if (plannedEnd < plannedStart) {
      return "Planned end must not be before planned start.";
    }
  }

  if (
    values.actual_started_at &&
    Number.isNaN(new Date(values.actual_started_at).getTime())
  ) {
    return "Actual start is invalid.";
  }
  if (
    values.actual_completed_at &&
    Number.isNaN(new Date(values.actual_completed_at).getTime())
  ) {
    return "Actual completion is invalid.";
  }
  if (values.actual_started_at && values.actual_completed_at) {
    const actualStart = new Date(values.actual_started_at);
    const actualEnd = new Date(values.actual_completed_at);
    if (
      Number.isNaN(actualStart.getTime()) ||
      Number.isNaN(actualEnd.getTime()) ||
      actualEnd < actualStart
    ) {
      return "Actual completion must not be before actual start.";
    }
  }
  return "";
}

export default function MaintenancePanel({ assetId, onChanged }) {
  const confirm = useConfirmation();
  const { user } = useAuth();
  const isSupervisor = user?.role === "Supervisor";
  const canAddMaintenance = user?.role === "Administrator";
  const canManageMaintenance = ["Administrator", "Supervisor"].includes(user?.role);
  const navigate = useNavigate();
  const [records, setRecords] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [schedulesLoaded, setSchedulesLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [deletingScheduleId, setDeletingScheduleId] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dialog, setDialog] = useState(null);
  const [materialViewer, setMaterialViewer] = useState(null);
  const [legacyRuleOptionsOpen, setLegacyRuleOptionsOpen] = useState(false);
  const [values, setValues] = useState(() => formValues(null));
  const [scheduleValues, setScheduleValues] = useState({
    title: "",
    maintenance_type: "preventive",
    priority: "medium",
    assigned_technician: "",
    description: "",
    schedule_start_date: todayDateInput(),
    first_due_date: "",
    recurrence_enabled: true,
    recurrence_interval: "1",
    recurrence_unit: "months",
    status: "active",
  });
  const [approvalDate, setApprovalDate] = useState("");
  const [clockNow, setClockNow] = useState(Date.now());

  const permanentlyDeleteRecord = async (record) => {
    if (!canManageMaintenance || busy) return;
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
        confirmLabel: "Continue",
        destructive: true,
      }))
    ) return;
    if (
      (scheduled || (record.planned_start_at && new Date(record.planned_start_at) > new Date())) &&
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
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api.del(`/maintenance/${record.id}/permanent`);
      setNotice("Maintenance was permanently deleted.");
      await Promise.all([loadRecords(), loadSchedules()]);
      await onChanged?.();
    } catch (requestError) {
      setError(
        requestError.message || "Could not permanently delete maintenance."
      );
    } finally {
      setBusy(false);
    }
  };

  const permanentlyDeleteSchedule = async (schedule) => {
    if (!canManageMaintenance || busy) return;
    const dueDate = schedule.current_due_date
      ? displayDate(schedule.current_due_date)
      : null;
    if (!(await confirm(
      `Delete maintenance schedule "${schedule.title}"${dueDate ? `, due ${dueDate}` : ""}, including its linked maintenance entries?`,
      {
        title: "Delete maintenance schedule",
        confirmLabel: "Continue",
        destructive: true,
      }
    ))) return;
    if (!(await confirm(
      `Confirm again: permanently delete schedule "${schedule.title}"${dueDate ? ` due ${dueDate}` : ""}? This cannot be undone.`,
      {
        title: "Confirm permanent deletion",
        confirmLabel: "Delete permanently",
        destructive: true,
      }
    ))) return;
    setBusy(true);
    setDeletingScheduleId(schedule.id);
    setError("");
    setNotice("");
    try {
      await api.del(`/maintenance/schedules/${schedule.id}/permanent`);
      setNotice("Maintenance schedule was permanently deleted.");
      await Promise.all([loadRecords(), loadSchedules()]);
      await onChanged?.();
    } catch (requestError) {
      setError(
        requestError.message || "Could not permanently delete maintenance schedule."
      );
    } finally {
      setDeletingScheduleId(null);
      setBusy(false);
    }
  };

  const loadRecords = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await api.getAll(
        `/maintenance?asset_id=${assetId}&limit=200`
      );
      setRecords(Array.isArray(result) ? result : []);
    } catch (requestError) {
      setError(requestError.message || "Could not load maintenance records.");
    } finally {
      setLoading(false);
    }
  }, [assetId]);

  const loadSchedules = useCallback(async () => {
    setSchedulesLoaded(false);
    try {
      const result = await api.getAll(`/maintenance/schedules?asset_id=${assetId}`);
      setSchedules(Array.isArray(result) ? result : []);
    } catch (requestError) {
      setError(requestError.message || "Could not load maintenance schedules.");
    } finally {
      setSchedulesLoaded(true);
    }
  }, [assetId]);

  useEffect(() => {
    loadRecords();
    loadSchedules();
  }, [loadRecords, loadSchedules]);

  useEffect(() => {
    const timerIsRunning = records.some((record) => record.status === "in_progress");
    if (!timerIsRunning) return undefined;
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [records]);

  useEffect(() => {
    if (!dialog || dialog.kind === "details") return;

    if (
      dialog.kind === "schedule-create" ||
      dialog.kind === "schedule-edit"
    ) {
      const record = dialog.record;

      setScheduleValues({
        title: record?.title || "",
        maintenance_type: record?.maintenance_type || "preventive",
        priority: record?.priority || "medium",
        assigned_technician: record?.assigned_technician || "",
        description: record?.description || "",
        schedule_start_date: record?.schedule_start_date
          ? String(record.schedule_start_date).slice(0, 10)
          : todayDateInput(),
        first_due_date: record?.first_due_date
          ? String(record.first_due_date).slice(0, 10)
          : "",
        recurrence_enabled:
          record?.recurrence_enabled == null
            ? true
            : Boolean(record.recurrence_enabled),
        recurrence_interval: String(record?.recurrence_interval ?? 1),
        recurrence_unit: record?.recurrence_unit || "months",
        status: record?.status || "active",
      });
      return;
    }

    if (dialog.record) {
      setValues(formValues(dialog.record));
    }
  }, [dialog]);

  const openCreate = () => {
    if (!canManageMaintenance) return;
    navigate(`/assets/${assetId}/maintenance/schedules/new`);
  };

const openScheduleEdit = (schedule) => {
  if (!canManageMaintenance) return;
  navigate(
    `/assets/${assetId}/maintenance/schedules/${schedule.id}/edit`
  );
};



const openEdit = (record) => {
  if (!canManageMaintenance) return;
  setError("");
  setNotice("");

  const editId = record.schedule_id || record.id;

  navigate(
    `/assets/${assetId}/maintenance/schedules/${editId}/edit`,
    {
      state: {
        maintenanceRecord: record,
      },
    }
  );
};

  const save = async (event) => {
    event.preventDefault();
    if (!canManageMaintenance || busy) return;
    setError("");
    setNotice("");
    if (dialog.kind === "schedule-create" || dialog.kind === "schedule-edit") {
      const form = scheduleValues;
      if (!form.title.trim() || !form.schedule_start_date || !form.first_due_date) {
        setError("Title, schedule start date, and first due date are required.");
        return;
      }
      if (form.first_due_date < form.schedule_start_date) {
        setError("First due date must not precede the schedule start date.");
        return;
      }
      if (
        form.recurrence_enabled &&
        (!Number.isInteger(Number(form.recurrence_interval)) ||
          Number(form.recurrence_interval) < 1)
      ) {
        setError("Recurrence interval must be a positive whole number.");
        return;
      }
      const schedulePayload = {
        title: form.title.trim(),
        maintenance_type: form.maintenance_type,
        priority: form.priority,
        assigned_technician: form.assigned_technician.trim() || null,
        description: form.description.trim() || null,
        schedule_start_date: form.schedule_start_date,
        first_due_date: form.first_due_date,
        recurrence_enabled: form.recurrence_enabled,
        recurrence_interval: form.recurrence_enabled
          ? Number(form.recurrence_interval)
          : null,
        recurrence_unit: form.recurrence_enabled ? form.recurrence_unit : null,
        ...(dialog.kind === "schedule-edit" ? { status: form.status } : {}),
      };
      setBusy(true);
      try {
        if (dialog.kind === "schedule-create") {
          await api.post("/maintenance/schedules", {
            asset_id: Number(assetId),
            ...schedulePayload,
          });
        } else {
          await api.patch(
            `/maintenance/schedules/${dialog.record.id}`,
            schedulePayload
          );
        }
        setDialog(null);
        setNotice(
          dialog.kind === "schedule-create"
            ? "Maintenance schedule created."
            : "Maintenance schedule updated."
        );
        await Promise.all([loadSchedules(), loadRecords()]);
        await onChanged?.();
      } catch (requestError) {
        setError(requestError.message || "Could not save maintenance schedule.");
      } finally {
        setBusy(false);
      }
      return;
    }
    if (!values.title.trim()) {
      setError("Maintenance title is required.");
      return;
    }
    const terminalRecord =
      dialog.kind === "edit" &&
      ["completed", "cancelled"].includes(dialog.record.status);
    const validationError = validateForm(
      values,
      dialog.kind === "create" || !terminalRecord
    );
    if (validationError) {
      setError(validationError);
      return;
    }

    const checklist = values.checklist
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => ({ item, completed: false }));
    const payload = {
      title: values.title.trim(),
      maintenance_type: values.maintenance_type,
      status: values.status,
      planned_start_at: nullableDate(values.planned_start_at),
      planned_end_at: nullableDate(values.planned_end_at),
      priority: values.priority,
      assigned_technician: values.assigned_technician.trim() || null,
      actual_started_at: nullableDate(values.actual_started_at),
      actual_completed_at:
        nullableDate(values.actual_completed_at) ||
        (dialog.kind === "create" && values.status === "completed"
          ? new Date().toISOString()
          : null),
      notes: values.notes.trim() || null,
      completion_notes: values.completion_notes.trim() || null,
      parts_used: values.parts_used.trim() || null,
      checklist: checklist.length ? checklist : null,
      next_due_at: nullableDate(values.next_due_at),
      alert_id: values.alert_id ? Number(values.alert_id) : null,
    };

    setBusy(true);
    try {
      await api.patch(`/maintenance/${dialog.record.id}`, payload);
      setDialog(null);
      setNotice("Maintenance job updated.");
      await loadRecords();
      await onChanged?.();
    } catch (requestError) {
      setError(requestError.message || "Could not save maintenance.");
    } finally {
      setBusy(false);
    }
  };

  const updateValue = (event) => {
    const { name, value } = event.target;
    setValues((previous) => ({ ...previous, [name]: value }));
  };
  const updateScheduleValue = (event) => {
    const { name, value, checked, type } = event.target;
    setScheduleValues((previous) => ({
      ...previous,
      [name]: type === "checkbox" ? checked : value,
    }));
  };
  const confirmNextOccurrence = async (schedule, dueDate) => {
    if (!canManageMaintenance || busy) return;
    if (!dueDate) {
      setError("Choose a due date before confirming the next occurrence.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.post(`/maintenance/schedules/${schedule.id}/confirm-next`, {
        due_date: dueDate,
      });
      setDialog(null);
      setNotice(`Next maintenance approved for ${displayDate(dueDate)}.`);
      await Promise.all([loadSchedules(), loadRecords()]);
    } catch (requestError) {
      setError(requestError.message || "Could not approve the next occurrence.");
    } finally {
      setBusy(false);
    }
  };
  const declineNextOccurrence = async (schedule) => {
    if (!canManageMaintenance || busy) return;
    setBusy(true);
    setError("");
    try {
      await api.post(`/maintenance/schedules/${schedule.id}/decline-next`);
      setDialog(null);
      setNotice("No next maintenance occurrence was scheduled.");
      await loadSchedules();
    } catch (requestError) {
      setError(requestError.message || "Could not decline the next occurrence.");
    } finally {
      setBusy(false);
    }
  };
  const changeScheduleStatus = async (schedule, status) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api.patch(`/maintenance/schedules/${schedule.id}`, { status });
      setNotice(status === "paused" ? "Recurrence paused." : "Recurrence resumed.");
      await loadSchedules();
    } catch (requestError) {
      setError(requestError.message || "Could not update recurrence status.");
    } finally {
      setBusy(false);
    }
  };
  const changeMaintenanceStatus = async (record) => {
    if (!canManageMaintenance || busy) return;
    const isStarting = record.status === "planned";
    if (!isStarting && record.status !== "in_progress") return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const updatedRecord = await api.post(
        `/maintenance/${record.id}/${isStarting ? "start" : "complete"}`
      );
      if (!isStarting && updatedRecord.schedule_id) {
        const updatedSchedules = await api.getAll(
          `/maintenance/schedules?asset_id=${assetId}`
        );
        setSchedules(Array.isArray(updatedSchedules) ? updatedSchedules : []);
        const updatedSchedule = updatedSchedules.find(
          (schedule) => schedule.id === updatedRecord.schedule_id
        );
        if (updatedSchedule?.approval_status === "pending") {
          setApprovalDate(updatedSchedule.proposed_due_date || "");
          setDialog({ kind: "approval", record: updatedSchedule });
        } else {
          setDialog({ kind: "details", record: updatedRecord });
        }
      } else {
        setDialog({ kind: "details", record: updatedRecord });
      }
      setRecords((previous) =>
        previous.map((item) => item.id === updatedRecord.id ? updatedRecord : item)
      );
      setNotice(isStarting ? "Maintenance started." : "Maintenance finished.");
      await loadRecords();
      await onChanged?.();
      if (!isStarting) await loadSchedules();
    } catch (requestError) {
      setError(requestError.message || `Could not ${isStarting ? "start" : "finish"} maintenance.`);
    } finally {
      setBusy(false);
    }
  };
  const terminalEdit =
    dialog?.kind === "edit" &&
    ["completed", "cancelled"].includes(dialog.record.status);
  const plannedDatesRequired =
    dialog?.kind === "create" ||
    (dialog?.kind === "edit" && !terminalEdit);
  const documentsForRecord = (record) =>
    schedules.find((schedule) => schedule.id === record.schedule_id)
      ?.instruction_documents || [];
  const today = todayDateInput();
  const visibleRecords = records.filter(
    (record) =>
      !(
        record.schedule_id != null &&
        (record.status === "in_progress" ||
          (record.status === "planned" &&
            record.planned_due_date <= today))
      )
  );
  const renderRecordCard = (record) => (
    <article
      className={`maintenance-record-card ${record.status || "planned"}`}
      key={record.id}
    >
      <span className="maintenance-record-indicator" aria-hidden="true" />
      <div className="maintenance-record-main">
        <strong>{record.title}</strong>
        <small>
          {record.maintenance_type || "Maintenance"} ·{" "}
          {record.priority || "medium"} priority
        </small>
      </div>
      <div className="maintenance-record-status">
        <span className={`maintenance-status ${record.status}`}>
          {record.status === "in_progress" ? (
            <><Timer size={13} aria-hidden="true" /> Started</>
          ) : String(record.status || "planned").replaceAll("_", " ")}
        </span>
        <small>
          {record.planned_start_at
            ? formatTime(record.planned_start_at)
            : "No planned start"}
          {" — "}
          {record.planned_end_at
            ? formatTime(record.planned_end_at)
            : "No planned end"}
        </small>
      </div>
      <div className="maintenance-record-meta">
        <span>
          <small>Technician</small>
          <strong>{record.assigned_technician || record.performed_by || "—"}</strong>
        </span>
        <span>
          <small>Planned duration</small>
          <strong>{plannedDurationDays(record)}</strong>
        </span>
        <span>
          <small>Actual duration</small>
          <strong>{actualDuration(record, clockNow)}</strong>
        </span>
      </div>
      <div className="maintenance-actions">
        <button
          type="button"
          className="btn-outline"
          onClick={() => setDialog({ kind: "details", record })}
          disabled={busy}
        >
          View
        </button>
        <button
          type="button"
          className="btn-outline"
          onClick={() => {
            const documents = documentsForRecord(record);
            if (documents.length > 0) {
              setMaterialViewer({
                document: documents[0],
                file: null,
                documents,
              });
            }
          }}
          disabled={busy || documentsForRecord(record).length === 0}
          title={
            documentsForRecord(record).length > 0
              ? "View attached instructions and documents"
              : "No instruction or document attached"
          }
        >
          <FileText size={14} aria-hidden="true" />
          Materials
        </button>
        {record.status !== "in_progress" && (
          <button
            type="button"
            className="maintenance-delete-icon"
            title={!canManageMaintenance
              ? "You do not have permission to change maintenance records."
              : record.schedule_id ? "Permanently delete schedule" : "Permanently delete maintenance"}
            aria-label={`Permanently delete ${record.schedule_id ? "schedule" : "maintenance"} ${record.title}`}
            onClick={() => permanentlyDeleteRecord(record)}
            disabled={busy || !canManageMaintenance}
          >
            <Trash2 size={16} aria-hidden="true" />
          </button>
        )}
      </div>
    </article>
  );

  return (
    <>
      <section className="panel maintenance-panel">
        <div className="panel-head maintenance-heading">
          <div>
            <h2>Maintenance management</h2>
            <p className="muted">
              Schedule, track and review work for this asset.
            </p>
          </div>
          <div className="maintenance-heading-actions">
            <button
            type="button"
            className="btn-primary"
            onClick={() => {
              if (!canAddMaintenance) return;
            }}
            disabled={!canAddMaintenance || busy}
            title={
              !canAddMaintenance
              ? "Only Administrators can add maintenance jobs."
              : "Add Maintenance"
              }
              >
                Add Maintenance
                </button>
          </div>
        </div>

        {error && <p className="notice error" role="alert">{error}</p>}
        {notice && <p className="notice" role="status">{notice}</p>}
        {!canManageMaintenance && (
          <p className="muted" role="status">
            Maintenance records and schedules are view-only for your role.
          </p>
        )}
        {loading ? (
          <p className="muted" role="status">Loading maintenance history…</p>
        ) : visibleRecords.length === 0 ? (
          <EmptyState
            art={false}
            title={records.length === 0 ? "No maintenance jobs" : "No other maintenance jobs"}
            lines={records.length === 0
              ? ["Create a job to start tracking planned and completed work."]
              : ["Due-today scheduled work and active scheduled work are shown in Current status."]}
          />
        ) : (
          <div className="maintenance-record-list">
            {visibleRecords.map(renderRecordCard)}
          </div>
        )}

      </section>

      {(dialog?.kind === "schedule-create" || dialog?.kind === "schedule-edit") && (
        <Modal title={dialog.kind === "schedule-create" ? "Add maintenance schedule" : "Edit maintenance schedule"} onClose={() => { if (!busy) setDialog(null); }} wide>
          <form className="maintenance-form" onSubmit={save}>
            {error && <p className="notice error" role="alert">{error}</p>}
            <fieldset disabled={!canManageMaintenance} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            <div className="maintenance-form-grid">
              <label className="field">Maintenance title <span className="req">*</span>
                <input name="title" value={scheduleValues.title} onChange={updateScheduleValue} maxLength={200} required disabled={busy || isSupervisor} />
              </label>
              <label className="field">Maintenance type
                <select name="maintenance_type" value={scheduleValues.maintenance_type} onChange={updateScheduleValue} disabled={busy || isSupervisor}>
                  {TYPES.map((item) => <option key={item} value={item}>{item[0].toUpperCase() + item.slice(1)}</option>)}
                </select>
              </label>
              <label className="field">Priority
                <select name="priority" value={scheduleValues.priority} onChange={updateScheduleValue} disabled={busy || isSupervisor}>
                  {PRIORITIES.map((item) => <option key={item} value={item}>{item[0].toUpperCase() + item.slice(1)}</option>)}
                </select>
              </label>
              <label className="field">Assigned technician
                <input name="assigned_technician" value={scheduleValues.assigned_technician} onChange={updateScheduleValue} maxLength={200} disabled={busy || isSupervisor} />
              </label>
              <label className="field">Schedule start date <span className="req">*</span>
                <input type="date" name="schedule_start_date" value={scheduleValues.schedule_start_date} onChange={updateScheduleValue} required disabled={busy || isSupervisor} />
                <small className="muted">The date this maintenance plan becomes effective.</small>
              </label>
              <label className="field">First maintenance due date <span className="req">*</span>
                <input type="date" name="first_due_date" value={scheduleValues.first_due_date} onChange={updateScheduleValue} required disabled={busy || isSupervisor} />
                <small className="muted">The date by which the first maintenance occurrence must be completed.</small>
              </label>
              {dialog.kind === "schedule-edit" && (
                <label className="field">Schedule status
                  <select name="status" value={scheduleValues.status} onChange={updateScheduleValue} disabled={busy || isSupervisor}>
                    {["active", "paused", "cancelled", "completed"].map((item) => <option key={item} value={item}>{item.replaceAll("_", " ")}</option>)}
                  </select>
                </label>
              )}
              <label className="field maintenance-checkbox">
                <input type="checkbox" name="recurrence_enabled" checked={scheduleValues.recurrence_enabled} onChange={updateScheduleValue} disabled={busy || isSupervisor} />
                Enable recurring maintenance
              </label>
              {scheduleValues.recurrence_enabled && (
                <>
                  <label className="field">Repeat every
                    <input type="number" name="recurrence_interval" min="1" max="3650" step="1" value={scheduleValues.recurrence_interval} onChange={updateScheduleValue} required disabled={busy} />
                  </label>
                  <label className="field">Recurrence unit
                    <select name="recurrence_unit" value={scheduleValues.recurrence_unit} onChange={updateScheduleValue} disabled={busy}>
                      {RECURRENCE_UNITS.map((item) => <option key={item} value={item}>{item[0].toUpperCase() + item.slice(1)}</option>)}
                    </select>
                  </label>
                </>
              )}
              <label className="field maintenance-form-wide">Description / work details
                <textarea name="description" value={scheduleValues.description} onChange={updateScheduleValue} rows={3} maxLength={10000} disabled={busy || isSupervisor} />
              </label>
            </div>
            </fieldset>
            {error && <p className="notice error" role="alert">{error}</p>}
            <div className="modal-actions">
              <button type="button" className="btn-outline" onClick={() => setDialog(null)} disabled={busy}>Cancel</button>
              <button type="submit" className="btn-primary" disabled={busy || !canManageMaintenance} title={!canManageMaintenance ? "You do not have permission to manage maintenance schedules." : undefined}>{busy ? "Saving…" : dialog.kind === "schedule-create" ? "Create schedule" : "Save schedule"}</button>
            </div>
          </form>
        </Modal>
      )}

      {dialog?.kind === "schedule-details" && (
        <Modal title="Maintenance schedule" onClose={() => setDialog(null)} wide>
          <dl className="maintenance-details">
            <dt>Title</dt><dd>{dialog.record.title}</dd>
            <dt>Schedule start</dt><dd>{displayDate(dialog.record.schedule_start_date)}</dd>
            <dt>First due date</dt><dd>{displayDate(dialog.record.first_due_date)}</dd>
            <dt>Current due date</dt><dd>{displayDate(dialog.record.current_due_date)}</dd>
            <dt>Recurrence</dt><dd>{dialog.record.recurrence_enabled ? `Every ${dialog.record.recurrence_interval} ${dialog.record.recurrence_unit}` : "Disabled"}</dd>
            <dt>Schedule status / due state</dt><dd>{String(dialog.record.status || "—").replaceAll("_", " ")} / {String(dialog.record.due_status || "—").replaceAll("_", " ")}</dd>
            <dt>Approval</dt><dd>{String(dialog.record.approval_status || "—").replaceAll("_", " ")}</dd>
            <dt>Proposed next due date</dt><dd>{displayDate(dialog.record.proposed_due_date)}</dd>
            <dt>Last completed</dt><dd>{dialog.record.last_completed_at ? formatTime(dialog.record.last_completed_at) : "—"}</dd>
            <dt>Assigned technician</dt><dd>{dialog.record.assigned_technician || "—"}</dd>
            <dt>Description</dt><dd>{dialog.record.description || "—"}</dd>
          </dl>
          <div className="modal-actions">
            <button type="button" className="btn-outline" onClick={() => setDialog(null)}>Close</button>
          </div>
        </Modal>
      )}

      {materialViewer && (
        <Modal
          title={materialViewer.file?.name || materialViewer.document.title || "Instructions and documents"}
          onClose={() => setMaterialViewer(null)}
          wide
        >
          {materialViewer.file ? (
            <>
              <button
                type="button"
                className="btn-outline"
                onClick={() => setMaterialViewer((current) => ({ ...current, file: null }))}
              >
                Back to instructions and documents
              </button>
              <iframe
                title={materialViewer.file.name}
                src={`${API_BASE}/documents/${materialViewer.document.id}/files/${materialViewer.file.id}/view`}
                className="maintenance-document-preview"
              />
            </>
          ) : (
            <div className="maintenance-material-list">
              {materialViewer.documents.map((document) => (
                <section key={document.id} className="maintenance-material-item">
                  <h3>{document.title || "Untitled document"}</h3>
                  <p className="muted">{document.kind || "Instruction"}</p>
                  {document.description && <p className="maintenance-instruction-text">{document.description}</p>}
                  {document.files?.length > 0 ? (
                    <div className="maintenance-material-files">
                      {document.files.map((file) => (
                        <button
                          key={file.id}
                          type="button"
                          className="btn-outline"
                          onClick={() => setMaterialViewer({ ...materialViewer, document, file })}
                        >
                          View {file.name}
                        </button>
                      ))}
                    </div>
                  ) : (
                    !document.description && <p className="muted">No instruction text or document file is available.</p>
                  )}
                </section>
              ))}
            </div>
          )}
          <div className="modal-actions">
            <button type="button" className="btn-outline" onClick={() => setMaterialViewer(null)}>Close</button>
          </div>
        </Modal>
      )}

      {dialog?.kind === "approval" && (
        <Modal title="Maintenance completed" onClose={() => { if (!busy) setDialog(null); }}>
          {error && <p className="notice error" role="alert">{error}</p>}
          <p>The previous maintenance was due on <strong>{displayDate(dialog.record.current_due_date)}</strong>.</p>
          <p>
            Based on the existing schedule
            {dialog.record.recurrence_interval ? ` (every ${dialog.record.recurrence_interval} ${dialog.record.recurrence_unit})` : ""},
            the next maintenance is proposed for{" "}
            <strong>{displayDate(dialog.record.proposed_due_date)}</strong>.
          </p>
          <p>
            Confirm the next occurrence for{" "}
            <strong>{displayDate(approvalDate || dialog.record.proposed_due_date)}</strong>
            {dialog.record.recurrence_interval ? ` with a recurrence of every ${dialog.record.recurrence_interval} ${dialog.record.recurrence_unit}.` : "."}
          </p>
          <label className="field">Confirmed next due date
            <input type="date" value={approvalDate} min={dialog.record.schedule_start_date} onChange={(event) => setApprovalDate(event.target.value)} disabled={busy || !canManageMaintenance} />
          </label>
          <p className="muted">Review the date and interval before approving the next occurrence.</p>
          <div className="modal-actions">
            <button type="button" className="btn-danger" onClick={() => declineNextOccurrence(dialog.record)} disabled={busy || !canManageMaintenance} title={!canManageMaintenance ? "You do not have permission to manage maintenance schedules." : undefined}>Do not schedule</button>
            <button type="button" className="btn-primary" onClick={() => confirmNextOccurrence(dialog.record, approvalDate)} disabled={busy || !canManageMaintenance} title={!canManageMaintenance ? "You do not have permission to manage maintenance schedules." : undefined}>Confirm date</button>
          </div>
        </Modal>
      )}

      {dialog?.kind === "details" && (
        <Modal title="Maintenance details" onClose={() => setDialog(null)} wide>
          {error && <p className="notice error" role="alert">{error}</p>}         
<div className="maintenance-detail-view">
  <div className="maintenance-detail-hero">
    <div className="maintenance-detail-symbol" aria-hidden="true">
      <span>⚙</span>
    </div>
    <div className="maintenance-detail-hero-copy">
      <span className="maintenance-detail-eyebrow">
        MAINTENANCE RECORD
      </span>
      <h3>{dialog.record.title || "Untitled maintenance"}</h3>
      <p>
        {String(dialog.record.maintenance_type || "maintenance")
          .replaceAll("_", " ")}
        {" · "}
        {dialog.record.priority || "medium"} priority
      </p>
    </div>
    <span
      className={`maintenance-detail-status maintenance-detail-status--${String(
        dialog.record.status || "planned"
      ).replaceAll("_", "-")}`}
    >
      {String(dialog.record.status || "planned").replaceAll("_", " ")}
    </span>
  </div>

  <div className="maintenance-detail-content">
    <section className="maintenance-detail-section">
      <h4>GENERAL INFORMATION</h4>
      <div className="maintenance-detail-grid">
        <div className="maintenance-detail-field">
          <span>Maintenance type</span>
          <strong>{dialog.record.maintenance_type || "—"}</strong>
        </div>
        <div className="maintenance-detail-field">
          <span>Priority</span>
          <strong>{dialog.record.priority || "—"}</strong>
        </div>
        <div className="maintenance-detail-field">
          <span>Assigned technician</span>
          <strong>
            {dialog.record.assigned_technician ||
              dialog.record.performed_by ||
              "—"}
          </strong>
        </div>
        <div className="maintenance-detail-field">
          <span>Actual duration</span>
          <strong>{actualDuration(dialog.record, clockNow)}</strong>
        </div>
      </div>
    </section>

    <section className="maintenance-detail-section">
      <h4>SCHEDULE & EXECUTION</h4>
      <div className="maintenance-detail-timeline">
        <div className="maintenance-detail-time">
          <span className="maintenance-detail-time-dot planned" />
          <div>
            <span>Planned start</span>
            <strong>{formatTime(dialog.record.planned_start_at)}</strong>
          </div>
        </div>
        <div className="maintenance-detail-time">
          <span className="maintenance-detail-time-dot planned" />
          <div>
            <span>Planned end</span>
            <strong>{formatTime(dialog.record.planned_end_at)}</strong>
          </div>
        </div>
        <div className="maintenance-detail-time">
          <span className="maintenance-detail-time-dot actual" />
          <div>
            <span>Actual start</span>
            <strong>{formatTime(dialog.record.actual_started_at)}</strong>
          </div>
        </div>
        <div className="maintenance-detail-time">
          <span className="maintenance-detail-time-dot actual" />
          <div>
            <span>Actual completion</span>
            <strong>{formatTime(dialog.record.actual_completed_at)}</strong>
          </div>
        </div>
      </div>
    </section>

    <section className="maintenance-detail-section">
      <h4>WORK DETAILS</h4>
      <div className="maintenance-detail-notes">
        {dialog.record.notes || "No work details provided."}
      </div>
    </section>

    <section className="maintenance-detail-section">
      <h4>COMPLETION SUMMARY</h4>
      <div className="maintenance-detail-grid">
        <div className="maintenance-detail-field">
          <span>Completion notes</span>
          <strong>
            {dialog.record.completion_notes || "—"}
          </strong>
        </div>
        <div className="maintenance-detail-field">
          <span>Parts used</span>
          <strong>{dialog.record.parts_used || "—"}</strong>
        </div>
        <div className="maintenance-detail-field">
          <span>Next maintenance</span>
          <strong>{formatTime(dialog.record.next_due_at)}</strong>
        </div>
        <div className="maintenance-detail-field">
          <span>Related alert</span>
          <strong>{dialog.record.alert_id || "—"}</strong>
        </div>
      </div>

      <div className="maintenance-detail-checklist">
        <span>Checklist</span>
        {dialog.record.checklist?.length ? (
          <ul>
            {dialog.record.checklist.map((item, index) => (
              <li key={`${item.item}-${index}`}>
                <span
                  className={
                    item.completed
                      ? "maintenance-check-done"
                      : "maintenance-check-pending"
                  }
                >
                  {item.completed ? "✓" : "○"}
                </span>
                {item.item}
              </li>
            ))}
          </ul>
        ) : (
          <p>No checklist items available.</p>
        )}
      </div>
    </section>
  </div>
</div>
          <div className="modal-actions">
            {dialog.record.status === "planned" && (
              <button
                type="button"
                className="btn-primary"
                onClick={() => changeMaintenanceStatus(dialog.record)}
                disabled={busy || !canManageMaintenance}
                title={!canManageMaintenance ? "You do not have permission to manage maintenance." : undefined}
              >
                {busy ? "Starting…" : "Start"}
              </button>
            )}
            {dialog.record.status === "in_progress" && (
              <button
                type="button"
                className="btn-primary"
                onClick={() => changeMaintenanceStatus(dialog.record)}
                disabled={busy || !canManageMaintenance}
                title={!canManageMaintenance ? "You do not have permission to manage maintenance." : undefined}
              >
                {busy ? "Finishing…" : "Finish"}
              </button>
            )}
            <button
            type="button"
            className="btn-outline"
            onClick={() => {
              const record = dialog.record;
              openEdit(record);
            }}
            disabled={busy || !canManageMaintenance}
            title={!canManageMaintenance ? "You do not have permission to edit maintenance records." : undefined}>Edit</button>
            <button
            type="button"
            className="btn-outline"
            onClick={() => setDialog(null)}
            disabled={busy}>Close</button>
          </div>
        </Modal>
      )}

      {dialog?.kind === "edit" && (
        <Modal title="Edit maintenance" onClose={() => { if (!busy) setDialog(null); }} wide>
          <form className="maintenance-form" onSubmit={save}>
            {error && <p className="notice error" role="alert">{error}</p>}
            <fieldset disabled={!canManageMaintenance} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            <div className="maintenance-form-grid">
              <label className="field">Title <span className="req">*</span>
                <input name="title" value={values.title} onChange={updateValue} required maxLength={200} disabled={busy || isSupervisor} />
              </label>
              <label className="field">Type <span className="req">*</span>
                <select name="maintenance_type" value={values.maintenance_type} onChange={updateValue} required disabled={busy || isSupervisor}>
                  {TYPES.map((item) => <option key={item} value={item}>{item[0].toUpperCase() + item.slice(1)}</option>)}
                </select>
              </label>
              {dialog.kind === "create" && (
             <label className="field">
  Status <span className="req">*</span>
  <select
    name="status"
    value={values.status}
    onChange={updateValue}
    required
    disabled={busy || isSupervisor}
  >
    {STATUSES.map((item) => (
      <option key={item} value={item}>
        {item.replaceAll("_", " ")}
      </option>
    ))}
  </select>
</label>
              )}
              <label className="field">Priority <span className="req">*</span>
                <select name="priority" value={values.priority} onChange={updateValue} required disabled={busy} />
              </label>
              <label className="field">Planned start {plannedDatesRequired && <span className="req">*</span>}
                <input type="datetime-local" name="planned_start_at" value={values.planned_start_at} onChange={updateValue} required={plannedDatesRequired} disabled={busy || isSupervisor} />
              </label>
              <label className="field">Planned end {plannedDatesRequired && <span className="req">*</span>}
                <input type="datetime-local" name="planned_end_at" value={values.planned_end_at} onChange={updateValue} required={plannedDatesRequired} disabled={busy || isSupervisor} />
              </label>
              <label className="field">Assigned technician
                <input name="assigned_technician" value={values.assigned_technician} onChange={updateValue} maxLength={200} disabled={busy} />
              </label>
              <label className="field">Related alert ID
                <input type="number" min="1" name="alert_id" value={values.alert_id} onChange={updateValue} disabled={busy || isSupervisor} />
              </label>
              <label className="field">Actual start
                <input type="datetime-local" name="actual_started_at" value={values.actual_started_at} onChange={updateValue} disabled={busy} />
              </label>
              <label className="field">Actual completion
                <input type="datetime-local" name="actual_completed_at" value={values.actual_completed_at} onChange={updateValue} disabled={busy} />
              </label>
              <label className="field">Next maintenance date
                <input type="datetime-local" name="next_due_at" value={values.next_due_at} onChange={updateValue} disabled={busy} />
              </label>
              <label className="field">Parts replaced or used
                <textarea name="parts_used" value={values.parts_used} onChange={updateValue} rows={2} disabled={busy} />
              </label>
              <label className="field maintenance-form-wide">Description / work details
                <textarea name="notes" value={values.notes} onChange={updateValue} rows={3} maxLength={10000} disabled={busy} />
              </label>
              <label className="field maintenance-form-wide">Completion notes
                <textarea name="completion_notes" value={values.completion_notes} onChange={updateValue} rows={3} disabled={busy} />
              </label>
              <label className="field maintenance-form-wide">Checklist (one item per line)
                <textarea name="checklist" value={values.checklist} onChange={updateValue} rows={3} disabled={busy} />
              </label>
            </div>
            </fieldset>
            <div className="modal-actions">
              <button type="button" className="btn-outline" onClick={() => setDialog(null)} disabled={busy}>Cancel</button>
              <button type="submit" className="btn-primary" disabled={busy || !canManageMaintenance} title={!canManageMaintenance ? "You do not have permission to manage maintenance." : undefined}>{busy ? "Saving…" : dialog.kind === "create" ? "Create maintenance" : "Save changes"}</button>
            </div>
          </form>
        </Modal>
      )}

      {legacyRuleOptionsOpen && (
        <Modal title="Additional asset rule workflows" onClose={() => setLegacyRuleOptionsOpen(false)}>
          <div className="rule-type-options">
            {LEGACY_RULE_CHOICES.map((choice) => (
              <button
                key={choice.kind}
                type="button"
                className="rule-type-option"
                onClick={() => {
                  setLegacyRuleOptionsOpen(false);
                  navigate(legacyRulePath(assetId, choice.kind));
                }}
              >
                <strong>{choice.label}</strong>
                <small>{choice.description}</small>
              </button>
            ))}
          </div>
        </Modal>
      )}
    </>
  );
}