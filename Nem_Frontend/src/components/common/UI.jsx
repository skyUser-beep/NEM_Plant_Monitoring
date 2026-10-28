
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import { EmptyArt } from "./Icons.jsx";

export const EmptyState = ({ title, lines = [], art = true }) => (
  <div className="empty">
    {art && <EmptyArt />}
    {title && <div className="empty-title">{title}</div>}
    {lines.map((line, index) => (
      <div key={index} className="empty-line">{line}</div>
    ))}
  </div>
);

export const CardLink = ({ to, icon: Icon, title, desc }) => (
  <Link to={to} className="cardlink">
    <div className="cardlink-ico">
      <Icon size={34} strokeWidth={1.5} />
    </div>
    <div className="cardlink-txt">
      <div className="cardlink-title">{title}</div>
      <div className="cardlink-desc">{desc}</div>
    </div>
  </Link>
);

const STATUS_LABEL = {
  ok: "Normal",
  normal: "Normal",
  warning: "Warning",
  alert: "Alert",
  evaluated: "Evaluated",
  unknown: "Not evaluated",
};

export const StatusBadge = ({ status }) => (
  <span className={"badge " + (status === "normal" ? "ok" : status || "unknown")}>
    {STATUS_LABEL[status] || status || "Not evaluated"}
  </span>
);

export const Modal = ({ title, onClose, children, wide }) => {
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape") onClose?.();
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="modal-bg" onClick={onClose}>
      <div
        className={"modal" + (wide ? " wide" : "")}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <h3>{title}</h3>
        {children}
      </div>
    </div>,
    document.body
  );
};

const MENU_MARGIN = 8;
const MENU_GAP = 4;

// Dropdown menu rendered in a portal with fixed positioning, so scroll
// containers and sibling stacking contexts cannot clip or cover it. It is
// anchored to the parent element of its placeholder, opens upward when there
// is not enough room below, and stays inside the viewport horizontally.
export function FloatingMenu({ align = "left", children, ...rest }) {
  const markerRef = useRef(null);
  const menuRef = useRef(null);

  useLayoutEffect(() => {
    const anchor = markerRef.current?.parentElement;
    const menu = menuRef.current;
    if (!anchor || !menu) return undefined;

    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = window.innerHeight;

      menu.style.maxHeight = "";
      const width = menu.offsetWidth;
      const height = menu.offsetHeight;
      const spaceBelow = viewportHeight - rect.bottom - MENU_GAP - MENU_MARGIN;
      const spaceAbove = rect.top - MENU_GAP - MENU_MARGIN;
      const openUp = height > spaceBelow && spaceAbove > spaceBelow;
      const available = Math.max(openUp ? spaceAbove : spaceBelow, 80);
      const shownHeight = Math.min(height, available);

      const top = openUp
        ? rect.top - MENU_GAP - shownHeight
        : rect.bottom + MENU_GAP;
      const preferredLeft = align === "right" ? rect.right - width : rect.left;
      const left = Math.max(
        MENU_MARGIN,
        Math.min(preferredLeft, viewportWidth - width - MENU_MARGIN)
      );

      menu.style.top = `${Math.max(MENU_MARGIN, top)}px`;
      menu.style.left = `${left}px`;
      menu.style.maxHeight = `${available}px`;
      menu.style.visibility = "visible";
    };

    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [align, children]);

  return (
    <>
      <span ref={markerRef} hidden />
      {createPortal(
        <div
          {...rest}
          ref={menuRef}
          className="menu floating-menu"
          style={{
            position: "fixed",
            visibility: "hidden",
            zIndex: 1000,
            maxWidth: `calc(100vw - ${MENU_MARGIN * 2}px)`,
            overflowY: "auto",
            boxSizing: "border-box",
          }}
        >
          {children}
        </div>,
        document.body
      )}
    </>
  );
}

const ConfirmationContext = createContext(null);

export function useConfirmation() {
  const confirm = useContext(ConfirmationContext);
  if (!confirm) {
    throw new Error("useConfirmation must be used inside ConfirmationProvider");
  }
  return confirm;
}

export function ConfirmationProvider({ children }) {
  const [request, setRequest] = useState(null);
  const resolver = useRef(null);

  const confirm = useCallback((message, options = {}) => {
    if (resolver.current) resolver.current(false);
    return new Promise((resolve) => {
      resolver.current = resolve;
      setRequest({
        message,
        title: options.title || "Please confirm",
        confirmLabel: options.confirmLabel || "Confirm",
        cancelLabel: options.cancelLabel || "Cancel",
        destructive: Boolean(options.destructive),
      });
    });
  }, []);

  const finish = useCallback((result) => {
    resolver.current?.(result);
    resolver.current = null;
    setRequest(null);
  }, []);

  return (
    <ConfirmationContext.Provider value={confirm}>
      {children}
      {request && (
        <Modal title={request.title} onClose={() => finish(false)}>
          <div className="confirmation-message">
            <span
              className={
                "confirmation-icon" +
                (request.destructive ? " destructive" : "")
              }
              aria-hidden="true"
            >
              <AlertTriangle size={20} />
            </span>
            <p>{request.message}</p>
          </div>
          <div className="modal-actions">
            <button
              type="button"
              className="btn-outline"
              onClick={() => finish(false)}
            >
              {request.cancelLabel}
            </button>
           <button
          type="button"
          className={request.destructive ? "btn-danger" : "btn-primary"}
          onClick={() => finish(true)}
          aria-label={request.confirmLabel || request.title}
          title={request.confirmLabel || request.title}
          >
            {request.confirmLabel}
            </button>
          </div>
        </Modal>
      )}
    </ConfirmationContext.Provider>
  );
}

const initialValue = (field) => {
  if (field.type === "files") return [];
  if (field.default !== undefined && field.default !== null) {
    return String(field.default);
  }
  return "";
};

export function CreateModal({
  title,
  fields,
  onSubmit,
  onClose,
  submitLabel = "Create",
  intro,
  initialValues = {},
  disabled = false,
}) {
  const [values, setValues] = useState(() =>
    Object.fromEntries(
      fields.map((field) => [
        field.key,
        initialValues[field.key] !== undefined &&
        initialValues[field.key] !== null
          ? String(initialValues[field.key])
          : initialValue(field),
      ])
    )
  );

  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const matchesConditions = (conditions, currentValues = values) =>
    !conditions ||
    (typeof conditions === "function"
      ? conditions(currentValues)
      : Array.isArray(conditions)
        ? conditions.every((condition) =>
            matchesConditions(condition, currentValues)
          )
        : conditions.anyOf
          ? conditions.anyOf.some((condition) =>
              matchesConditions(condition, currentValues)
            )
          : currentValues[conditions.key] === conditions.equals);

  const isVisible = (field) => matchesConditions(field.showWhen);

  const isRequired = (field) =>
    Boolean(
      field.required ||
      (field.requiredWhen && matchesConditions(field.requiredWhen))
    );

  const optionsFor = (field, currentValues = values) =>
    typeof field.options === "function"
      ? field.options(currentValues)
      : field.options || [];

  const handleChange = (event) => {
    const { name, value } = event.target;
    setValues((current) => ({ ...current, [name]: value }));
    setError("");
  };

  const set = (key, value) => {
    setValues((current) => ({ ...current, [key]: value }));
    setError("");
  };

  useEffect(() => {
    setValues((current) => {
      let changed = Object.keys(current).length !== fields.length;

      const next = Object.fromEntries(
        fields.map((field) => {
          const hasCurrent = Object.hasOwn(current, field.key);
          const hasInitial = Object.hasOwn(initialValues, field.key);

          let value = hasCurrent
            ? current[field.key]
            : hasInitial
              ? String(initialValues[field.key] ?? "")
              : initialValue(field);

          if (
            field.type === "select" &&
            value !== "" &&
            !optionsFor(field, current).some(
              ([option]) => String(option) === String(value)
            )
          ) {
            value = initialValue(field);
          }

          if (!hasCurrent || value !== current[field.key]) {
            changed = true;
          }

          return [field.key, value];
        })
      );

      return changed ? next : current;
    });
  }, [fields, initialValues]);

  const submit = async (event) => {
    event.preventDefault();
    if (disabled) return;

    for (const field of fields) {
      if (
        isVisible(field) &&
        isRequired(field) &&
        !(
          field.type === "files"
            ? Array.isArray(values[field.key]) &&
              values[field.key].length > 0
            : String(values[field.key] ?? "").trim()
        )
      ) {
        setError(`${field.label} is required.`);
        return;
      }
    }

    const normalized = {};

    for (const field of fields) {
      const value =
        values[field.key] ??
        (field.type === "files" ? [] : "");

      if (field.type === "files") {
        normalized[field.key] = value;
      } else if (
        field.type === "number" &&
        String(value).trim() !== ""
      ) {
        const number = Number(value);

        if (!Number.isFinite(number)) {
          setError(`${field.label} must be a valid number.`);
          return;
        }

        normalized[field.key] = number;
      } else {
        normalized[field.key] = value;
      }
    }

    setBusy(true);
    setError("");

    try {
      await onSubmit(normalized);
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={title} onClose={onClose} wide>
      <form onSubmit={submit}>
        {intro && <p className="muted modal-intro">{intro}</p>}

        
        {fields.filter(isVisible).map((field, index) => (
          <div className="field" key={field.key}>
            <label htmlFor={"f-" + field.key}>
              {field.label}
              {isRequired(field) && <span className="req"> *</span>}
            </label>

            {field.type === "files" ? (
              <>
                <input
                  id={"f-" + field.key}
                  type="file"
                  multiple
                  accept={field.accept || ".pdf,.doc,.docx,.txt"}
                  disabled={Boolean(field.disabled || busy || disabled)}
                  onChange={(event) =>
                    set(field.key, Array.from(event.target.files || []))
                  }
                />

                {Array.isArray(values[field.key]) &&
                  values[field.key].length > 0 && (
                    <ul className="hint">
                      {values[field.key].map((file) => (
                        <li key={`${file.name}-${file.size}`}>
                          {file.name} ({(file.size / 1024).toFixed(1)} KB)
                        </li>
                      ))}
                    </ul>
                  )}
              </>
            ) : field.type === "textarea" ? (
              <textarea
                id={"f-" + field.key}
                rows={3}
                placeholder={field.placeholder}
                value={values[field.key] ?? ""}
                disabled={Boolean(field.disabled || busy || disabled)}
                onChange={(event) => set(field.key, event.target.value)}
              />
            ) : field.type === "select" ? (
              <select
                id={"f-" + field.key}
                value={values[field.key] ?? ""}
                required={isRequired(field)}
                disabled={Boolean(field.disabled || busy || disabled)}
                onChange={(event) => {
                  const value = event.target.value;
                  set(field.key, value);

                  if (field.onChange) {
                    field.onChange(value, values, setValues);
                  }
                }}
              >
                <option value="" disabled={Boolean(field.required)}>
                  {field.placeholder ||
                    `Select ${field.label.toLowerCase()}`}
                </option>

                {optionsFor(field).map(([option, label]) => (
                  <option key={String(option)} value={String(option)}>
                    {label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={"f-" + field.key}
                type={field.type || "text"}
                step={field.type === "number" ? "any" : undefined}
                autoFocus={index === 0}
                required={isRequired(field)}
                disabled={Boolean(field.disabled || busy || disabled)}
                placeholder={field.placeholder}
                value={values[field.key] ?? ""}
                onChange={(event) => set(field.key, event.target.value)}
              />
            )}

            {field.hint && <span className="hint">{field.hint}</span>}
          </div>
        ))}

        {error && (
          <p className="notice error" role="alert">{error}</p>
        )}

        <div className="modal-actions">
          <button
            type="button"
            className="btn-outline"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>

          <button
            type="submit"
            className="btn-primary"
            disabled={busy || disabled}
            title={
              disabled
                ? "You do not have permission to perform this action."
                : undefined
            }
          >
            {busy ? "Saving..." : submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
