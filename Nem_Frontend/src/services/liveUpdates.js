import { getAuthToken } from "./api.js";

const API_BASE = import.meta.env.VITE_API_URL || "/api/v1";
const subscribers = new Set();
const seenEventIds = new Set();
const MAX_SEEN_EVENT_IDS = 500;

let socket = null;
let reconnectTimer = null;
let staleTimer = null;
let reconnectDelay = 500;
let hasConnected = false;

function websocketUrl() {
  const apiUrl = new URL(API_BASE, window.location.href);
  apiUrl.protocol = apiUrl.protocol === "https:" ? "wss:" : "ws:";
  apiUrl.pathname = `${apiUrl.pathname.replace(/\/+$/, "")}/ws/live`;
  apiUrl.search = "";
  apiUrl.hash = "";
  return apiUrl.toString();
}

function notifySubscribers(update) {
  for (const subscriber of subscribers) {
    try {
      subscriber(update);
    } catch (error) {
      console.error("Live update subscriber failed.", error);
    }
  }
}

function connect() {
  if (
    socket ||
    reconnectTimer ||
    subscribers.size === 0 ||
    typeof WebSocket === "undefined"
  ) {
    return;
  }

  const token = getAuthToken();
  if (!token) return;
  const connection = new WebSocket(websocketUrl(), [`nem-auth.${token}`, "nem-auth"]);
  socket = connection;

  const resetStaleTimer = () => {
    if (staleTimer) {
      window.clearTimeout(staleTimer);
    }
    staleTimer = window.setTimeout(() => connection.close(), 55000);
  };

  connection.onopen = () => {
    resetStaleTimer();
  };
  connection.onmessage = (message) => {
    let update;
    try {
      update = JSON.parse(message.data);
    } catch (error) {
      console.error("Received an invalid live update.", error);
      return;
    }
    reconnectDelay = 500;
    resetStaleTimer();
    if (update.type === "heartbeat") {
      return;
    }
    if (update.event_id) {
      if (seenEventIds.has(update.event_id)) {
        return;
      }
      seenEventIds.add(update.event_id);
      if (seenEventIds.size > MAX_SEEN_EVENT_IDS) {
        seenEventIds.delete(seenEventIds.values().next().value);
      }
    }
    if (update.type === "connected") {
      if (hasConnected) {
        update = { ...update, type: "reconnected", resync_required: true };
      } else {
        hasConnected = true;
      }
    }
    notifySubscribers(update);
  };
  connection.onerror = () => {
    connection.close();
  };
  connection.onclose = () => {
    if (staleTimer) {
      window.clearTimeout(staleTimer);
      staleTimer = null;
    }
    if (socket === connection) {
      socket = null;
    }
    if (subscribers.size === 0) {
      return;
    }
    notifySubscribers({ type: "disconnected" });
    if (reconnectTimer) return;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  };
}

export function createLiveUpdateScheduler(callback, delay = 200) {
  let timer = null;
  let running = false;
  let pending = false;
  let disposed = false;

  const request = () => {
    if (disposed) return;
    if (running) {
      pending = true;
      return;
    }
    if (timer !== null) return;
    timer = window.setTimeout(run, delay);
  };

  const run = async () => {
    timer = null;
    if (disposed) return;
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      await callback();
    } catch (error) {
      console.error("Scheduled live refresh failed.", error);
    } finally {
      running = false;
      if (pending && !disposed) {
        pending = false;
        request();
      }
    }
  };

  request.dispose = () => {
    disposed = true;
    pending = false;
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };
  return request;
}

export function subscribeLiveUpdates(subscriber) {
  subscribers.add(subscriber);
  connect();

  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size > 0) {
      return;
    }
    if (reconnectTimer) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (socket) {
      const connection = socket;
      socket = null;
      connection.close();
    }
    if (staleTimer) {
      window.clearTimeout(staleTimer);
      staleTimer = null;
    }
  };
}