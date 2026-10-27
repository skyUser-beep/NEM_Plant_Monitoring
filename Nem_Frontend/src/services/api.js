const BASE = (import.meta.env.VITE_API_URL || "/api/v1").replace(/\/+$/, "");
export const AUTH_TOKEN_KEY = "access_token";

export function getAuthToken() {
  try {
    return localStorage.getItem(AUTH_TOKEN_KEY);
  } catch {
    return null;
  }
}


function describeError(body, fallback) {
  if (body && typeof body === "object") {
    const details = body.error?.details;
    if (Array.isArray(details) && details.length) {
      return details
        .map((item) => {
          const where = (item.loc || []).filter((part) => part !== "body").join(".");
          return where ? `${where}: ${item.msg}` : item.msg;
        })
        .join("; ");
    }
    const detail = body.detail ?? body.error?.message;
    if (typeof detail === "string") return detail;
    if (detail) return JSON.stringify(detail);
  }
  if (typeof body === "string" && body.trim()) return body;
  return fallback;
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function req(path, opts = {}) {
  let res;
  try {

const token = getAuthToken();

res = await fetch(`${BASE}${path}`, {
  ...opts,
  headers: {
    ...(opts.body && !(opts.body instanceof FormData)
      ? { "Content-Type": "application/json" }
      : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...opts.headers,
  },
});

  } catch {
    throw new ApiError(
      "Cannot reach the backend. Check that the API server is running on port 8000.",
      0
    );
  }

  const text = await res.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!res.ok) {
    if (res.status === 401 && !pathIsLogin(path)) {
      window.dispatchEvent(new Event("nem-auth-expired"));
    }
    throw new ApiError(describeError(body, res.statusText || "Request failed"), res.status);
  }

  function pathIsLogin(path) {
    return path === "/auth/login";
  }
  return body;
}


async function getAll(path, pageSize = 200) {
  const joiner = path.includes("?") ? "&" : "?";
  const all = [];
  let offset = 0;
  for (let guard = 0; guard < 200; guard += 1) {
    const page = await req(`${path}${joiner}limit=${pageSize}&offset=${offset}`);
    if (Array.isArray(page)) return page;
    const items = Array.isArray(page?.items) ? page.items : [];
    all.push(...items);
    offset += items.length;
    if (items.length === 0 || offset >= (page?.total ?? 0)) break;
  }
  return all;
}

export const api = {
  get: async (p) => {
    const result = await req(p);
    return result && Array.isArray(result.items) ? result.items : result;
  },
  getAll,
  post: (p, body = {}) => req(p, { method: "POST", body: JSON.stringify(body) }),
  postForm: (p, formData) =>
    req(p, { method: "POST", body: formData }),
  put: (p, body) => req(p, { method: "PUT", body: JSON.stringify(body) }),
  patch: (p, body) => req(p, { method: "PATCH", body: JSON.stringify(body) }),
  del: (p) => req(p, { method: "DELETE" }),
};
