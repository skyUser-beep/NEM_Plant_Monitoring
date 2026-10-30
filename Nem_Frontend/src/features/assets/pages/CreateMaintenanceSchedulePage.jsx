
import React, { useEffect, useState } from "react";
import { api } from "../../../services/api.js";
import { useAuth } from "../../auth/AuthContext.jsx";
import "./CreateMaintenanceSchedulePage.css";
import { useNavigate, useParams, useLocation } from "react-router-dom";

const TYPES = [
  "preventive",
  "corrective",
  "inspection",
  "unplanned",
];

const PRIORITIES = ["low", "medium", "high", "critical"];

const RECURRENCE_UNITS = ["days", "weeks", "months", "years"];

function todayDateInput() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60000;

  return new Date(now.getTime() - offset)
    .toISOString()
    .slice(0, 10);
}

function localDateTimeInput(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function utcDateTime(value) {
  return value ? new Date(value).toISOString() : null;
}

function getErrorMessage(err, fallback) {
  return (
    err?.response?.data?.detail ||
    err?.response?.data?.message ||
    err?.message ||
    fallback
  );
}

function getDocumentsArray(response) {
  const data = response?.data ?? response;

  if (Array.isArray(data)) {
    return data;
  }

  if (Array.isArray(data?.documents)) {
    return data.documents;
  }

  if (Array.isArray(data?.items)) {
    return data.items;
  }

  if (Array.isArray(data?.results)) {
    return data.results;
  }

  return [];
}

export default function CreateMaintenanceSchedulePage() {
  const { user } = useAuth();
  const canManageMaintenance = ["Administrator", "Supervisor"].includes(user?.role);
  const isSupervisor = user?.role === "Supervisor";
  const { id, scheduleId, recordId } = useParams();
  const isStandaloneEdit = Boolean(recordId);
  const isEdit = Boolean(scheduleId || recordId);
  const navigate = useNavigate();
  const location = useLocation();
  const maintenanceRecord = location.state?.maintenanceRecord;

  const [form, setForm] = useState({
    title: "",
    maintenance_type: "preventive",
    priority: "medium",
    assigned_technician: "",
    description: "",
    actual_started_at: "",
    actual_completed_at: "",
    completion_notes: "",
    parts_used: "",
    checklist: "",
    next_due_at: "",
    alert_id: "",
    schedule_start_date: todayDateInput(),
    first_due_date: "",
    recurrence_enabled: true,
    recurrence_interval: "1",
    recurrence_unit: "months",
  });

  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(isEdit);
  const [editingBlocked, setEditingBlocked] = useState(isEdit);
  const [error, setError] = useState("");

  // Instructions and documents picker state.
  const [instructionPickerOpen, setInstructionPickerOpen] =
    useState(false);
  const [instructions, setInstructions] = useState([]);
  const [selectedDocuments, setSelectedDocuments] = useState([]);
  const [instructionsLoading, setInstructionsLoading] =
    useState(false);
  const [instructionsError, setInstructionsError] = useState("");
  const [instructionSearch, setInstructionSearch] = useState("");

  useEffect(() => {
    if (!isEdit) {
      setLoading(false);
      return undefined;
    }

    let cancelled = false;

    async function loadSchedule() {
      setLoading(true);
      setEditingBlocked(isEdit);
      setError("");

      try {
        let record;
        let currentOccurrence = null;

        if (scheduleId) {
          const response = await api.get(
            `/maintenance/schedules/${scheduleId}`
          );
          const data = response?.data ?? response;
          record = data?.schedule ?? data;
          const currentOccurrenceId =
            record?.current_occurrence_id ??
            (maintenanceRecord?.schedule_id === Number(scheduleId)
              ? maintenanceRecord.id
              : null);
          if (currentOccurrenceId != null) {
            const occurrenceResponse = await api.get(
              `/maintenance/${currentOccurrenceId}`
            );
            const occurrenceData =
              occurrenceResponse?.data ?? occurrenceResponse;
            currentOccurrence = occurrenceData?.record ?? occurrenceData;
          }
        } else if (isStandaloneEdit) {
          const response = await api.get(`/maintenance/${recordId}`);
          const data = response?.data ?? response;
          record = data?.record ?? data;
          currentOccurrence = record;
        } else {
          record = maintenanceRecord;
        }

        if (
          !record ||
          typeof record !== "object" ||
          Array.isArray(record)
        ) {
          throw new Error("Invalid maintenance data returned.");
        }

        if (cancelled) return;

        const activeOccurrence = currentOccurrence?.status === "in_progress";
        setEditingBlocked(activeOccurrence);
        if (activeOccurrence) {
          setError("In-progress maintenance cannot be edited.");
        }

        const startDate = isStandaloneEdit
          ? localDateTimeInput(record.planned_start_at || record.start_date)
          : record.schedule_start_date ||
            record.planned_start_at ||
            record.start_date ||
            todayDateInput();
        const dueDate = isStandaloneEdit
          ? localDateTimeInput(record.planned_end_at || record.next_due_at)
          : record.first_due_date ||
            record.planned_end_at ||
            record.next_due_at ||
            "";

        setForm({
          title: record.title ?? "",
          maintenance_type:
            record.maintenance_type ?? "preventive",
          priority: record.priority ?? "medium",
          assigned_technician:
            record.assigned_technician ?? "",
          description:
            record.description ?? record.notes ?? "",
          actual_started_at: localDateTimeInput(record.actual_started_at),
          actual_completed_at: localDateTimeInput(record.actual_completed_at),
          completion_notes: record.completion_notes ?? "",
          parts_used: record.parts_used ?? "",
          checklist: (record.checklist || [])
            .map((item) => item.item || "")
            .join("\n"),
          next_due_at: localDateTimeInput(record.next_due_at),
          alert_id: record.alert_id ? String(record.alert_id) : "",
          schedule_start_date: String(startDate).slice(
            0,
            isStandaloneEdit ? 16 : 10
          ),
          first_due_date: dueDate
            ? String(dueDate).slice(0, isStandaloneEdit ? 16 : 10)
            : "",
          recurrence_enabled: Boolean(record.recurrence_enabled),
          recurrence_interval: String(
            record.recurrence_interval ?? 1
          ),
          recurrence_unit:
            record.recurrence_unit ?? "months",
        });
        setSelectedDocuments(record.instruction_documents || []);
      } catch (err) {
        console.error("Failed to load maintenance:", err);

        if (!cancelled) {
          if (isEdit) setEditingBlocked(true);
          setError(
            getErrorMessage(
              err,
              "Could not load maintenance details."
            )
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadSchedule();

    return () => {
      cancelled = true;
    };
  }, [isEdit, isStandaloneEdit, scheduleId, recordId, maintenanceRecord]);


  const updateField = (event) => {
    const { name, value, checked, type } = event.target;

    setForm((previous) => ({
      ...previous,
      [name]: type === "checkbox" ? checked : value,
    }));
  };

  // Load instructions and documents for the picker.
  const loadInstructions = async () => {
    setInstructionsLoading(true);
    setInstructionsError("");

    try {
      const response = await api.get("/documents");
      const documents = getDocumentsArray(response);

      setInstructions(documents);
    } catch (err) {
      console.error("Failed to load documents:", err);

      setInstructionsError(
        getErrorMessage(
          err,
          "Instructions and documents could not be loaded."
        )
      );
    } finally {
      setInstructionsLoading(false);
    }
  };

  const openInstructionPicker = () => {
    setInstructionPickerOpen(true);
    setInstructionSearch("");
    loadInstructions();
  };

  const toggleInstruction = (item) => {
    setSelectedDocuments((previous) =>
      previous.some((selected) => selected.id === item.id)
        ? previous.filter((selected) => selected.id !== item.id)
        : [...previous, item]
    );
    setInstructionsError("");
  };

  const goToMaintenanceLog = () => {
    navigate(`/assets/${id}`, {
      state: { activeTab: "logbook" },
    });
  };

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (!canManageMaintenance || busy || editingBlocked) return;

    setError("");

    if (!String(id ?? "").trim() || !Number.isFinite(Number(id))) {
      setError("A valid asset ID is required.");
      return;
    }

    if (!isSupervisor && !form.title.trim()) {
      setError("Maintenance title is required.");
      return;
    }

    if (
      !form.schedule_start_date ||
      !form.first_due_date
    ) {
      setError(
        "Schedule start date and first due date are required."
      );
      return;
    }

    if (form.first_due_date < form.schedule_start_date) {
      setError(
        "First due date must not precede the schedule start date."
      );
      return;
    }

    const interval = Number(form.recurrence_interval);

    if (
      form.recurrence_enabled &&
      (!Number.isInteger(interval) ||
        interval < 1 ||
        interval > 3650)
    ) {
      setError(
        "Recurrence interval must be a whole number between 1 and 3650."
      );
      return;
    }

    const scheduleDates = {
      schedule_start_date: form.schedule_start_date,
      first_due_date: form.first_due_date,
    };
    const payload = isSupervisor
      ? scheduleDates
      : {
          title: form.title.trim(),
          maintenance_type: form.maintenance_type,
          priority: form.priority,
          assigned_technician:
            form.assigned_technician.trim() || null,
          description: form.description.trim() || null,
          ...scheduleDates,
          recurrence_enabled: form.recurrence_enabled,
          recurrence_interval: form.recurrence_enabled
            ? interval
            : null,
          recurrence_unit: form.recurrence_enabled
            ? form.recurrence_unit
            : null,
          instruction_document_ids: selectedDocuments.map((item) => item.id),
        };
    const checklistItems = form.checklist
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => ({ item, completed: false }));

    setBusy(true);

    try {
      if (isStandaloneEdit) {
        const recordPayload = isSupervisor
          ? {
              planned_start_at: utcDateTime(form.schedule_start_date),
              planned_end_at: utcDateTime(form.first_due_date),
            }
          : {
              title: form.title.trim(),
              maintenance_type: form.maintenance_type,
              priority: form.priority,
              assigned_technician:
                form.assigned_technician.trim() || null,
              notes: form.description.trim() || null,
              planned_start_at: utcDateTime(form.schedule_start_date),
              planned_end_at: utcDateTime(form.first_due_date),
              actual_started_at: utcDateTime(form.actual_started_at),
              actual_completed_at: utcDateTime(form.actual_completed_at),
              completion_notes: form.completion_notes.trim() || null,
              parts_used: form.parts_used.trim() || null,
              checklist: checklistItems.length ? checklistItems : null,
              next_due_at: utcDateTime(form.next_due_at),
              ...(form.alert_id.trim()
                ? { alert_id: Number(form.alert_id) }
                : {}),
            };
        await api.patch(`/maintenance/${recordId}`, recordPayload);
      } else if (isEdit) {
        await api.patch(`/maintenance/schedules/${scheduleId}`, payload);
      } else {
        await api.post("/maintenance/schedules", {
          asset_id: Number(id),
          ...payload,
        });
      }

      navigate(`/assets/${id}`, {
        state: {
          activeTab: "logbook",
          createdNotice: isEdit
            ? "Maintenance schedule updated."
            : "Maintenance schedule created.",
        },
      });
    } catch (requestError) {
      console.error(
        "Maintenance schedule request failed:",
        requestError
      );

      setError(
        getErrorMessage(
          requestError,
          `Could not ${
            isEdit ? "update" : "create"
          } maintenance schedule.`
        )
      );
    } finally {
      setBusy(false);
    }
  };

  const filteredInstructions = instructions.filter((item) => {
    const query = instructionSearch.trim().toLowerCase();

    if (!query) return true;

    return [
      item.title,
      item.kind,
      item.description,
    ].some((value) =>
      String(value || "").toLowerCase().includes(query)
    );
  });

  return (
    <main className="create-schedule-page">
      <div className="create-schedule-header">
        <button
          type="button"
          className="btn-outline"
          onClick={goToMaintenanceLog}
          disabled={busy}
        >
          ← Back to Maintenance log
        </button>

        <div>
          <p className="create-schedule-eyebrow">
            MAINTENANCE MANAGEMENT
          </p>

          <h1>
            {isEdit ? "Edit maintenance" : "Add maintenance"}
            </h1>

          <p className="create-schedule-subtitle">
          {isSupervisor
            ? "Update only the maintenance schedule dates. Other maintenance details are read-only."
            : "Configure the maintenance plan, first due date and recurrence for this asset."}
          </p>
        </div>
      </div>

      <form
        className="create-schedule-card"
        onSubmit={handleSubmit}
      >
        {error && (
          <div className="notice error" role="alert">
            {error}
          </div>
        )}
        {!canManageMaintenance && (
          <div className="notice" role="status">
            You do not have permission to create or edit maintenance schedules.
          </div>
        )}

        {loading ? (
          <p className="muted">
            Loading maintenance schedule...
          </p>
        ) : (
          <>
            <fieldset
              className="create-schedule-fieldset"
              disabled={busy || !canManageMaintenance || editingBlocked}
            >
              {!isSupervisor && <section className="create-schedule-section">
                <h2>Schedule details</h2>

                <p className="muted">
                  Enter the basic maintenance information.
                </p>

                <div className="create-schedule-grid">
                  <label className="field">
                    <span className="field-label">
                      Maintenance title <span className="req" aria-hidden="true">*</span>
                    </span>

                    <input
                      name="title"
                      value={form.title}
                      onChange={updateField}
                      maxLength={200}
                      required
                      placeholder="e.g. Monthly machine inspection"
                    />
                  </label>

                  <label className="field">
                    <span className="field-label">Assigned technician</span>

                    <input
                      name="assigned_technician"
                      value={form.assigned_technician}
                      onChange={updateField}
                      maxLength={200}
                      placeholder="Technician name"
                    />
                  </label>

                  <label className="field">
                    <span className="field-label">Maintenance type</span>
                    <select
                      name="maintenance_type"
                      value={form.maintenance_type}
                      onChange={updateField}
                    >
                      {TYPES.map((type) => (
                        <option key={type} value={type}>
                          {type.charAt(0).toUpperCase() + type.slice(1)}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="field">
                    <span className="field-label">Priority</span>
                    <select
                      name="priority"
                      value={form.priority}
                      onChange={updateField}
                    >
                      {PRIORITIES.map((priority) => (
                        <option key={priority} value={priority}>
                          {priority.charAt(0).toUpperCase() + priority.slice(1)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </section>}

              {isStandaloneEdit && !isSupervisor && (
                <section className="create-schedule-section">
                  <h2>Execution details</h2>
                  <p className="muted">
                    Update the existing execution and completion fields for this maintenance record.
                  </p>
                  <div className="create-schedule-grid">
                    <label className="field">
                      <span className="field-label">Actual start</span>
                      <input
                        type="datetime-local"
                        name="actual_started_at"
                        value={form.actual_started_at}
                        onChange={updateField}
                      />
                    </label>
                    <label className="field">
                      <span className="field-label">Actual completion</span>
                      <input
                        type="datetime-local"
                        name="actual_completed_at"
                        value={form.actual_completed_at}
                        onChange={updateField}
                      />
                    </label>
                    <label className="field">
                      <span className="field-label">Next due date and time</span>
                      <input
                        type="datetime-local"
                        name="next_due_at"
                        value={form.next_due_at}
                        onChange={updateField}
                      />
                    </label>
                    <label className="field">
                      <span className="field-label">Alert ID</span>
                      <input
                        type="number"
                        name="alert_id"
                        min="1"
                        value={form.alert_id}
                        onChange={updateField}
                      />
                    </label>
                    <label className="field">
                      <span className="field-label">Parts used</span>
                      <textarea
                        name="parts_used"
                        value={form.parts_used}
                        onChange={updateField}
                        rows={3}
                        maxLength={10000}
                      />
                    </label>
                    <label className="field">
                      <span className="field-label">Completion notes</span>
                      <textarea
                        name="completion_notes"
                        value={form.completion_notes}
                        onChange={updateField}
                        rows={3}
                        maxLength={10000}
                      />
                    </label>
                    <label className="field">
                      <span className="field-label">Checklist items</span>
                      <textarea
                        name="checklist"
                        value={form.checklist}
                        onChange={updateField}
                        rows={4}
                        placeholder="One checklist item per line"
                      />
                    </label>
                  </div>
                </section>
              )}

              <section className="create-schedule-section">
                <h2>Dates</h2>

                <p className="muted">
                  {isSupervisor
                    ? "Supervisors may update only these schedule dates."
                    : "Select when the plan starts and when the first maintenance is due."}
                </p>

                <div className="create-schedule-grid">
                  <label className="field">
                    <span className="field-label">
                      {isStandaloneEdit ? "Planned start date and time" : "Schedule start date"} <span className="req" aria-hidden="true">*</span>
                    </span>

                    <input
                      type={isStandaloneEdit ? "datetime-local" : "date"}
                      name="schedule_start_date"
                      value={form.schedule_start_date}
                      onChange={updateField}
                      required
                    />

                    <small className="muted">
                      When this maintenance plan becomes effective.
                    </small>
                  </label>

                  <label className="field">
                    <span className="field-label">
                      {isStandaloneEdit ? "Planned due date and time" : "First maintenance due date"} <span className="req" aria-hidden="true">*</span>
                    </span>

                    <input
                      type={isStandaloneEdit ? "datetime-local" : "date"}
                      name="first_due_date"
                      value={form.first_due_date}
                      min={form.schedule_start_date || undefined}
                      onChange={updateField}
                      required
                    />

                    <small className="muted">
                      The due date for the first maintenance
                      occurrence.
                    </small>
                  </label>
                </div>
              </section>

              {!isSupervisor && <section className="create-schedule-section">
                <h2>Recurring maintenance</h2>

                <p className="muted">
                  Automatically plan repeated maintenance when
                  recurrence is enabled.
                </p>

                <label className="field create-schedule-checkbox">
                  <input
                    type="checkbox"
                    name="recurrence_enabled"
                    checked={form.recurrence_enabled}
                    onChange={updateField}
                  />

                  Enable recurring maintenance
                </label>

                {form.recurrence_enabled && (
                  <div className="create-schedule-grid recurrence-grid">
                    <label className="field">
                      <span className="field-label">Repeat every</span>

                      <input
                        type="number"
                        name="recurrence_interval"
                        min="1"
                        max="3650"
                        step="1"
                        value={form.recurrence_interval}
                        onChange={updateField}
                        required
                      />
                    </label>

                    <label className="field">
                      <span className="field-label">Recurrence unit</span>

                      <select
                        name="recurrence_unit"
                        value={form.recurrence_unit}
                        onChange={updateField}
                        required
                      >
                        {RECURRENCE_UNITS.map((item) => (
                          <option key={item} value={item}>
                            {item.charAt(0).toUpperCase() +
                              item.slice(1)}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                )}
              </section>}

              {!isSupervisor && <section className="create-schedule-section">
                <h2>Description / work details</h2>

                <p className="muted">
                  Instructions for the maintenance team.
                </p>

                <label className="field">
                  <span className="field-label">Description / work details</span>

                  <textarea
                    name="description"
                    value={form.description}
                    onChange={updateField}
                    rows={3}
                    maxLength={10000}
                    placeholder="Enter maintenance instructions..."
                  />
                </label>
                <button
                  type="button"
                  className="btn-outline create-schedule-instructions"
                  onClick={openInstructionPicker}
                  disabled={busy}
                >
                  Add from instructions and documents
                </button>
                {selectedDocuments.length > 0 && (
                  <div className="selected-instruction-list" aria-live="polite">
                    <h3>Attached instructions and documents</h3>
                    {selectedDocuments.map((item) => (
                      <div className="selected-instruction-item" key={item.id}>
                        <span>
                          <strong>{item.title || "Untitled document"}</strong>
                          <small>{item.kind || "Document"}</small>
                        </span>
                        <button
                          type="button"
                          className="btn-outline"
                          onClick={() => setSelectedDocuments((previous) =>
                            previous.filter((selected) => selected.id !== item.id)
                          )}
                          disabled={busy}
                          aria-label={`Remove ${item.title || "document"}`}
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </section>}
            </fieldset>

            <div className="create-schedule-actions">
              <button
                type="button"
                className="btn-outline"
                onClick={goToMaintenanceLog}
                disabled={busy}
              >
                Cancel
              </button>

              <button
                type="submit"
                className="btn-primary"
                disabled={busy || !canManageMaintenance || editingBlocked}
                title={
                  editingBlocked
                    ? "In-progress maintenance cannot be edited."
                    : !canManageMaintenance
                      ? "You do not have permission to create or edit maintenance schedules."
                      : undefined
                }
              >
                {busy
                ? isEdit
                ? "Updating maintenance..."
                : "Creating maintenance..."
                : isEdit
                ? "Save changes"
                : "Add maintenance"}
              </button>
            </div>
          </>
        )}
      </form>

      {instructionPickerOpen && (
  <div
    className="instruction-picker-overlay"
    role="presentation"
    onClick={() => setInstructionPickerOpen(false)}
  >
    <section
      className="instruction-picker-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="instruction-picker-title"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="instruction-picker-header">
        <div>
          <h2 id="instruction-picker-title">
            Instructions and documents
          </h2>
          <p className="muted">
            Select the instructions and documents to attach to this maintenance schedule.
          </p>
        </div>

        <button
          type="button"
          className="btn-outline"
          onClick={() => setInstructionPickerOpen(false)}
        >
          Close
        </button>
      </div>

      <input
        type="search"
        value={instructionSearch}
        onChange={(event) =>
          setInstructionSearch(event.target.value)
        }
        placeholder="Search instructions and documents..."
        aria-label="Search instructions and documents"
      />

      {instructionsLoading && (
        <p className="muted">Loading documents...</p>
      )}

      {instructionsError && (
        <div className="notice error" role="alert">
          {instructionsError}
        </div>
      )}

      {!instructionsLoading &&
        !instructionsError &&
        filteredInstructions.length === 0 && (
          <p className="muted">
            {instructions.length === 0
              ? "No documents were returned by the API. Check the browser console and API response."
              : "No documents match your search."}
          </p>
        )}

      {!instructionsLoading && (
        <div className="instruction-document-grid">
          {filteredInstructions.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`instruction-document-tile${selectedDocuments.some((selected) => selected.id === item.id) ? " selected" : ""}`}
              onClick={() => toggleInstruction(item)}
              aria-pressed={selectedDocuments.some((selected) => selected.id === item.id)}
            >
              <strong>{item.title || "Untitled document"}</strong>

              <span className="muted">
                {item.kind || item.document_type || "Document"}
              </span>

              {item.description && (
                <span>{item.description}</span>
              )}

              <span className="muted">
                {Array.isArray(item.files)
                  ? item.files.length
                  : 0}{" "}
                attachment(s) ·{" "}
                {selectedDocuments.some((selected) => selected.id === item.id)
                  ? "Selected"
                  : "Click to select"}
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  </div>
)}
    </main>
  );
}
