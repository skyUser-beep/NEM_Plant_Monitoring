
import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../../services/api.js";
import { useAuth } from "../../auth/AuthContext.jsx";
import "./CreateInstructionPage.css";

export default function CreateInstructionPage() {
  const { user } = useAuth();
  const canManageInstructions =
    user?.role === "Administrator" || user?.role === "Supervisor";
  const nav = useNavigate();

  const [name, setName] = useState("");
  const [labels, setLabels] = useState([]);
  const [labelInput, setLabelInput] = useState("");
  const [duration, setDuration] = useState("30");
  const [text, setText] = useState("");
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function addLabel() {
    if (!canManageInstructions) return;
    const label = labelInput.trim();

    if (!label) return;

    if (label.length < 2 || label.length > 50) {
      setError("Label must contain 2–50 characters.");
      return;
    }

    if (labels.length >= 10) {
      setError("Maximum 10 labels are allowed.");
      return;
    }

    if (
      labels.some(
        (item) => item.toLowerCase() === label.toLowerCase()
      )
    ) {
      setError("This label already exists.");
      return;
    }

    setLabels((current) => [...current, label]);
    setLabelInput("");
    setError("");
  }

  async function submit(event) {
    event.preventDefault();
    if (!canManageInstructions) return;
    setError("");

    const cleanName = name.trim();
    const cleanText = text.trim();
    const minutes = Number(duration);

    if (cleanName.length < 2 || cleanName.length > 50) {
      setError("Name must contain 2–50 characters.");
      return;
    }

    if (!Number.isInteger(minutes) || minutes < 1) {
      setError("Duration must be at least 1 minute.");
      return;
    }

    if (!cleanText || cleanText.length > 10000) {
      setError(
        "Instruction text is required and limited to 10,000 characters."
      );
      return;
    }

    if (files.length > 10) {
      setError("You can attach up to 10 documents.");
      return;
    }
    if (files.some((file) => file.size > 10 * 1024 * 1024)) {
      setError("Each document must be 10 MB or smaller.");
      return;
    }

    setBusy(true);

    try {
      const form = new FormData();
      form.append("title", cleanName);
      form.append("kind", "Instruction");
      form.append("description", cleanText);
      form.append("labels", JSON.stringify(labels));
      form.append("duration_minutes", String(minutes));
      files.forEach((file) => form.append("files", file));
      await api.postForm("/documents/with-files", form);

      nav("/configuration/documents", {
        state: { documentCreated: true },
      });
    } catch (err) {
      setError(
        err.message || "Unable to create instruction."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="create-instruction-page">
      <button
        type="button"
        className="link-btn"
        onClick={() => nav("/configuration/documents")}
      >
        ← Back to Instructions and documents
      </button>

      <header className="instruction-page-heading">
        <h1 className="page-title">
          Create New Instruction
        </h1>

        <p>
          Define the task instructions and expected duration.
        </p>
      </header>

      <form
        className="panel instruction-form"
        onSubmit={submit}
      >
        {!canManageInstructions && (
          <p className="notice" role="status">
            Only Administrators and Supervisors can create instructions.
          </p>
        )}
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}

        <fieldset
          disabled={!canManageInstructions || busy}
          style={{ border: 0, margin: 0, minWidth: 0, padding: 0 }}
        >
        <div className="instruction-field">
          <label htmlFor="instruction-name">
            Name *
          </label>

          <input
            id="instruction-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            minLength={2}
            maxLength={50}
            required
            placeholder="Enter instruction name"
          />
        </div>

        <div className="instruction-field">
          <label htmlFor="instruction-label">
            Labels
          </label>

          <div className="instruction-label-entry">
            <input
              id="instruction-label"
              value={labelInput}
              maxLength={50}
              placeholder="Enter a label"
              onChange={(e) =>
                setLabelInput(e.target.value)
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addLabel();
                }
              }}
            />

            <button
              type="button"
              className="btn-secondary"
              onClick={addLabel}
              disabled={labels.length >= 10}
            >
              Add
            </button>
          </div>

          <div className="instruction-label-list">
            {labels.map((label) => (
              <span
                className="instruction-label-chip"
                key={label}
              >
                {label}

                <button
                  type="button"
                  aria-label={`Remove ${label}`}
                  onClick={() =>
                    setLabels((current) =>
                      current.filter(
                        (item) => item !== label
                      )
                    )
                  }
                >
                  ×
                </button>
              </span>
            ))}
          </div>

          <small>{labels.length}/10 labels</small>
        </div>

        <div className="instruction-field">
          <label htmlFor="instruction-duration">
            Duration in minutes *
          </label>

          <input
            id="instruction-duration"
            type="number"
            min="1"
            step="1"
            required
            value={duration}
            onChange={(e) =>
              setDuration(e.target.value)
            }
          />
        </div>

        <div className="instruction-field">
          <label htmlFor="instruction-text">
            Instructions Text *
          </label>

          <textarea
            id="instruction-text"
            rows={8}
            maxLength={10000}
            required
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Write the instructions here..."
          />

          <small>
            {text.length}/10,000 characters
          </small>
        </div>

        <div className="instruction-field">
          <label htmlFor="instruction-documents">Attach documents (optional)</label>
          <input
            id="instruction-documents"
            type="file"
            accept=".pdf,.doc,.docx,.txt"
            multiple
            disabled={busy}
            onChange={(event) => {
              setFiles(Array.from(event.target.files || []));
              setError("");
            }}
          />
          <small>PDF, DOC, DOCX or TXT. Up to 10 documents, 10 MB each.</small>
          {files.length > 0 && (
            <ul>
              {files.map((file) => <li key={`${file.name}-${file.lastModified}`}>{file.name}</li>)}
            </ul>
          )}
        </div>
        </fieldset>

        <div className="instruction-form-actions">
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() =>
              nav("/configuration/documents")
            }
          >
            Cancel
          </button>

          <button
            type="submit"
            className="btn-primary"
            disabled={busy || !canManageInstructions}
            title={!canManageInstructions ? "Only Administrators and Supervisors can create instructions." : undefined}
          >
            {busy ? "Submitting..." : "Submit"}
          </button>
        </div>
      </form>
    </div>
  );
}
