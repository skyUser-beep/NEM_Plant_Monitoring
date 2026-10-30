function isInternalPath(pathname) {
  return (
    typeof pathname === "string" &&
    pathname.startsWith("/") &&
    !pathname.startsWith("//")
  );
}

export function captureNavigationOrigin(location, state = location?.state) {
  return {
    pathname: location?.pathname,
    search: location?.search || "",
    hash: location?.hash || "",
    key: location?.key,
    state: state && typeof state === "object" ? state : null,
  };
}

export function resolveNavigationOrigin(origin, fallback) {
  const candidate =
    typeof origin === "string"
      ? { pathname: origin }
      : origin;
  const target =
    candidate && isInternalPath(candidate.pathname)
      ? candidate
      : typeof fallback === "string"
        ? { pathname: fallback }
        : fallback;

  if (!target || !isInternalPath(target.pathname)) {
    throw new Error("A valid internal navigation fallback is required.");
  }

  return {
    pathname: target.pathname,
    search: target.search || "",
    hash: target.hash || "",
    key: target.key,
    state: target.state && typeof target.state === "object"
      ? target.state
      : null,
  };
}

function saveNavigationFlash(origin, notice) {
  if (!origin?.key || (!notice && !origin.state)) return;
  window.sessionStorage.setItem(
    `nem-navigation-flash:${origin.key}`,
    JSON.stringify({
      text: notice?.text || "",
      state: origin.state || null,
    })
  );
}

export function rememberNavigationOrigin(origin) {
  saveNavigationFlash(origin, null);
}

export function hasNavigationFlash(location) {
  if (!location?.key) return false;
  return Boolean(
    window.sessionStorage.getItem(
      `nem-navigation-flash:${location.key}`
    )
  );
}

export function consumeNavigationFlash(location) {
  if (!location?.key) return null;
  const key = `nem-navigation-flash:${location.key}`;
  const stored = window.sessionStorage.getItem(key);
  window.sessionStorage.removeItem(key);
  if (!stored) return null;
  try {
    const flash = JSON.parse(stored);
    return {
      text: flash.text || "",
      error: false,
      state:
        flash.state && typeof flash.state === "object"
          ? flash.state
          : null,
    };
  } catch (error) {
    console.error("Could not restore navigation context:", error);
    return null;
  }
}

export function returnToNavigationOrigin(
  navigate,
  origin,
  fallback,
  { notice = null } = {}
) {
  const target = resolveNavigationOrigin(origin, fallback);
  const originPathname =
    typeof origin === "string" ? origin : origin?.pathname;
  if (
    isInternalPath(originPathname) &&
    origin &&
    typeof origin === "object" &&
    origin.key
  ) {
    saveNavigationFlash(origin, notice);
    navigate(-1);
    return;
  }

  navigate(
    { pathname: target.pathname, search: target.search, hash: target.hash },
    {
      replace: true,
      state: {
        ...target.state,
        ...(notice?.text ? { createdNotice: notice.text } : {}),
      },
    }
  );
}
