import React, { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, getAuthToken } from "../../../services/api.js";

const API_BASE = (import.meta.env.VITE_API_URL || "/api/v1").replace(/\/+$/, "");

export default function DocumentViewerPage() {
  const { documentId, fileId } = useParams();
  const [fileName, setFileName] = useState("Document preview");
  const [error, setError] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    let objectUrl = "";

    api.get("/documents")
      .then((documents) => {
        const file = (Array.isArray(documents) ? documents : [])
          .find((document) => String(document.id) === documentId)
          ?.files?.find((item) => String(item.id) === fileId);
        if (active && file) setFileName(file.name);
      })
      .catch((loadError) => {
        if (active) {
          setError(loadError.message || "Could not load document details.");
        }
      });

    const token = getAuthToken();
    fetch(`${API_BASE}/documents/${documentId}/files/${fileId}/view`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          let message = `Could not load document preview (${response.status}).`;
          const responseText = await response.text();
          if (responseText) {
            try {
              const body = JSON.parse(responseText);
              message = body.detail || message;
            } catch {
              message = responseText;
            }
          }
          throw new Error(message);
        }
        return response.blob();
      })
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setPreviewUrl(objectUrl);
      })
      .catch((loadError) => {
        if (active && loadError.name !== "AbortError") {
          setError(loadError.message || "Could not load document preview.");
        }
      });

    return () => {
      active = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [documentId, fileId]);

  return (
    <section className="panel" style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <Link className="btn-outline" to="/configuration/documents">
          Back to documents
        </Link>
        <h1 className="page-title" style={{ margin: 0 }}>{fileName}</h1>
      </div>
      {error && <p className="notice error" role="alert">{error}</p>}
      <iframe
        title={fileName}
        src={previewUrl || undefined}
        style={{
          width: "100%",
          height: "min(75vh, 900px)",
          border: "1px solid var(--line)",
          borderRadius: 6,
          background: "white",
        }}
      />
    </section>
  );
}
