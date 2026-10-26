
import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../../services/api.js";
import { useAuth } from "../../auth/AuthContext.jsx";
import { BackIcon } from "../../../components/common/Icons.jsx";
import "./DocumentCreatePage.css";

const DOC_TYPES = [
  ["Instruction", "Instruction"],
  ["Manual", "Manual"],
  ["Checklist", "Checklist"],
  ["Other", "Other"],
];

export default function DocumentCreatePage() {
  const { user } = useAuth();
  const canManageDocuments =
    user?.role === "Administrator" || user?.role === "Supervisor";
  const nav = useNavigate();

  const [title, setTitle] = useState("");
  const [kind, setKind] = useState("Instruction");
  const [description, setDescription] = useState("");
  const [files, setFiles] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    if (!canManageDocuments) return;
    setError("");

    if (!title.trim()) {
      setError("Title is required.");
      return;
    }

    if (files.length > 10) {
      setError("You can attach up to 10 files.");
      return;
    }

    if (files.some((file) => file.size > 10 * 1024 * 1024)) {
      setError("Each file must be 10 MB or smaller.");
      return;
    }

    setBusy(true);

    try {
      if (files.length) {
        const form = new FormData();
        form.append("title", title.trim());
        form.append("kind", kind);
        form.append("description", description.trim());
        files.forEach((file) => form.append("files", file));

        await api.postForm("/documents/with-files", form);
      } else {
        await api.post("/documents", {
          title: title.trim(),
          kind,
          description: description.trim() || null,
        });
      }

      nav("/configuration/documents", {
        state: { documentCreated: true },
      });
    } catch (err) {
      setError(err?.message || "Could not create document.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="document-create-page">
      <button
        type="button"
        className="link-btn document-back"
        onClick={() => nav("/configuration/documents")}
      >
        <BackIcon size={14} /> Back to documents
      </button>

      <header className="document-hero">
        <div className="document-hero-icon">
          <svg
            width="29"
            height="29"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
            <path d="M13 2v7h7" />
            <path d="M8 13h8M8 17h8" />
            <path d="M8 9h1" />
          </svg>
        </div>

        <div className="document-hero-copy">
          <h1>Create document</h1>
          <p>
            Add instructions, manuals and checklists to keep important
            machine information organised and accessible.
          </p>
        </div>
      </header>

      <section className="document-form-card">
        <div className="document-form-heading">
          <div className="document-section-icon">
            <svg
              width="21"
              height="21"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L9 17l-4 1 1-4Z" />
            </svg>
          </div>
          <div>
            <h2>Document details</h2>
            <p>Enter the document information and attach relevant files.</p>
          </div>
        </div>

        <div className="document-form-body">
          <form onSubmit={submit}>
            {!canManageDocuments && (
              <p className="notice" role="status">
                Only Administrators and Supervisors can create documents.
              </p>
            )}
            <fieldset
              disabled={!canManageDocuments || busy}
              style={{ border: 0, margin: 0, minWidth: 0, padding: 0 }}
            >
            <div className="document-fields-grid">
              <div className="field">
                <label htmlFor="document-title">
                  Title <span className="req">*</span>
                </label>
                <input
                  id="document-title"
                  autoFocus
                  required
                  value={title}
                  placeholder="e.g. Mixer inspection steps"
                  disabled={busy}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </div>

              <div className="field">
                <label htmlFor="document-kind">Type</label>
                <select
                  id="document-kind"
                  value={kind}
                  disabled={busy}
                  onChange={(event) => setKind(event.target.value)}
                >
                  {DOC_TYPES.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field document-description-field">
                <label htmlFor="document-description">Description</label>
                <textarea
                  id="document-description"
                  rows={4}
                  value={description}
                  placeholder="Add useful details about this document..."
                  disabled={busy}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </div>

              <div className="field document-attachments-field">
                <label htmlFor="document-files">
                  Attach files <span className="muted">(optional)</span>
                </label>

                <div className="document-upload-zone">
                  <div className="document-upload-icon">
                    <svg
                      width="26"
                      height="26"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <path d="m17 8-5-5-5 5" />
                      <path d="M12 3v12" />
                    </svg>
                  </div>

                  <div className="document-upload-title">
                    Upload your files
                  </div>
                  <div className="document-upload-subtitle">
                    PDF, DOC, DOCX or TXT · Up to 10 files · 10 MB each
                  </div>

                  <input
                    id="document-files"
                    type="file"
                    multiple
                    accept=".pdf,.doc,.docx,.txt"
                    disabled={busy}
                    onChange={(event) =>
                      setFiles(Array.from(event.target.files || []))
                    }
                  />

                  {files.length > 0 && (
                    <div className="document-selected-files">
                      {files.map((file) => (
                        <div
                          className="document-selected-file"
                          key={`${file.name}-${file.size}`}
                        >
                          <div className="document-selected-file-icon">
                            <svg
                              width="18"
                              height="18"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.8"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden="true"
                            >
                              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                              <path d="M14 2v6h6" />
                              <path d="M8 13h8M8 17h8" />
                            </svg>
                          </div>
                          <div className="document-selected-file-info">
                            <div className="document-selected-file-name">
                              {file.name}
                            </div>
                            <div className="document-selected-file-size">
                              {(file.size / 1024).toFixed(1)} KB
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {error && (
              <p className="notice error document-form-error" role="alert">
                {error}
              </p>
            )}

            </fieldset>
            <div className="document-form-footer">
              <span className="document-footer-note">
                <span className="req">*</span> Required field
              </span>

              <div className="document-form-actions">
                <button
                  type="button"
                  className="btn-outline"
                  disabled={busy}
                  onClick={() => nav("/configuration/documents")}
                >
                  Cancel
                </button>

                <button
                  type="submit"
                  className="btn-primary"
                  disabled={busy || !canManageDocuments}
                  title={!canManageDocuments ? "Only Administrators and Supervisors can create documents." : undefined}
                >
                  {busy ? "Saving..." : "Create document"}
                </button>
              </div>
            </div>
          </form>
        </div>
      </section>
    </div>
  );
}
