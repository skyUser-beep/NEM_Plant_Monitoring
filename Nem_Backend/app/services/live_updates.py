#Live update system for backend
import asyncio
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable
from uuid import uuid4

from fastapi import WebSocket, WebSocketDisconnect
from sqlalchemy import event
from sqlalchemy.orm import Session

_CRITICAL_TABLES = {
    "nem_alerts", # alert records
    "nem_monitoring_events", # monitoring events
}
_MAX_RETAINED_CRITICAL_EVENTS = 256 #Maximum number of critical events retained 
#Tracking which db entities changed ,tells the code which IDs to collect for each table.
_ENTITY_ID_ATTRIBUTES = {
    "assets": ("id",),
    "variables": ("id", "asset_id"),
    "readings": ("id", "asset_id", "variable_id"),
    "nem_readings": ("id", "asset_id", "variable_id"),
    "nem_monitoring_rules": ("id", "target_asset_id", "variable_id"),
    "nem_rule_states": ("id", "rule_id", "target_asset_id", "target_variable_id"),
    "nem_rule_counter_states": ("id", "rule_id", "asset_id"),
    "machine_monitoring_states": ("asset_id",),
    "nem_alerts": ("id", "rule_id", "target_asset_id", "maintenance_schedule_id"),
    "nem_monitoring_events": ("id", "rule_id", "asset_id", "alert_id"),
    "nem_maintenance_records": ("id", "asset_id", "alert_id", "schedule_id"),
    "nem_maintenance_schedules": ("id", "asset_id"),
}

#Think of it like a notification manager 
class LiveUpdateHub:
    def __init__(self) -> None:
        self._loop: asyncio.AbstractEventLoop | None = None
        self._subscribers: set[asyncio.Queue[dict[str, Any]]] = set()
        self._database_change_listeners: set[Callable[[set[str]], None]] = set()
        self._pending_tables: set[str] = set()
        self._pending_asset_ids: set[int] = set()
        self._pending_entity_ids: dict[str, set[int]] = {}
        self._flush_handle: asyncio.TimerHandle | None = None

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop
#Connecting the frontend to live updates
    def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=32)
        self._subscribers.add(queue)
        queue.put_nowait(self._event("connected"))
        return queue

    def unsubscribe(self, queue: asyncio.Queue[dict[str, Any]]) -> None:
        self._subscribers.discard(queue)

    def add_database_change_listener(self, listener: Callable[[set[str]], None]) -> None:
        self._database_change_listeners.add(listener)

    def publish_from_session(
        self,
        changed_tables: set[str],
        asset_ids: set[int],
        entity_ids: dict[str, set[int]] | None = None,
    ) -> None:
        if not changed_tables or self._loop is None or self._loop.is_closed():
            return
        self._loop.call_soon_threadsafe(
            self._queue_database_change,
            changed_tables,
            asset_ids,
            entity_ids or {},
        )

    def _queue_database_change(
        self,
        changed_tables: set[str],
        asset_ids: set[int],
        entity_ids: dict[str, set[int]],
    ) -> None:
        self._pending_tables.update(changed_tables)
        self._pending_asset_ids.update(asset_ids)
        for table, identifiers in entity_ids.items():
            self._pending_entity_ids.setdefault(table, set()).update(identifiers)
        if self._flush_handle is None:
            assert self._loop is not None
            self._flush_handle = self._loop.call_later(0.15, self._flush_database_changes)

    def _flush_database_changes(self) -> None:
        self._flush_handle = None
        tables = self._pending_tables
        asset_ids = self._pending_asset_ids
        entity_ids = self._pending_entity_ids
        self._pending_tables = set()
        self._pending_asset_ids = set()
        self._pending_entity_ids = {}
        if not tables:
            return

        for listener in tuple(self._database_change_listeners):
            listener(set(tables))

        self._publish(
            self._event(
                "database_change",
                changed_tables=tables,
                asset_ids=asset_ids,
                entity_ids=entity_ids,
                critical=bool(tables & _CRITICAL_TABLES),
            )
        )

    def publish_status(self) -> None:
        if self._loop is None or self._loop.is_closed():
            return
        self._loop.call_soon_threadsafe(
            self._publish,
            self._event("opcua_status"),
        )

    @staticmethod
    def _event(
        event_type: str,
        *,
        changed_tables: set[str] | None = None,
        asset_ids: set[int] | None = None,
        entity_ids: dict[str, set[int]] | None = None,
        critical: bool = False,
        resync_required: bool = False,
        critical_events_truncated: bool = False,
    ) -> dict[str, Any]:
        return {
            "event_id": str(uuid4()),
            "type": event_type,
            "occurred_at": datetime.now(timezone.utc).isoformat(),
            "changed_tables": sorted(changed_tables or ()),
            "asset_ids": sorted(asset_ids or ()),
            "entity_ids": {
                table: sorted(ids)
                for table, ids in (entity_ids or {}).items()
                if ids
            },
            "payload": {},
            "critical": critical,
            "resync_required": resync_required,
            "critical_events": [],
            "critical_events_truncated": critical_events_truncated,
        }

    @staticmethod
    def _merge_events(
        pending: list[dict[str, Any]],
        incoming: dict[str, Any],
    ) -> dict[str, Any]:
        events = [*pending, incoming]
        tables = set().union(*(set(item.get("changed_tables", ())) for item in events))
        assets = set().union(*(set(item.get("asset_ids", ())) for item in events))
        entities: dict[str, set[int]] = {}
        for item in events:
            for table, ids in item.get("entity_ids", {}).items():
                entities.setdefault(table, set()).update(ids)
        merged = LiveUpdateHub._event(
            "database_change" if tables else incoming["type"],
            changed_tables=tables,
            asset_ids=assets,
            entity_ids=entities,
            critical=any(item.get("critical", False) for item in events),
            resync_required=True,
        )
        retained_events = []
        for item in events:
            retained_events.extend(item.get("critical_events", ()))
            if item.get("critical") and not item.get("resync_required"):
                retained_events.append(item)
        truncated = any(
            item.get("critical_events_truncated", False) for item in events
        )
        if len(retained_events) > _MAX_RETAINED_CRITICAL_EVENTS:
            retained_events = retained_events[-_MAX_RETAINED_CRITICAL_EVENTS:]
            truncated = True
        merged["critical_events"] = retained_events
        merged["critical_events_truncated"] = truncated
        return merged

    def _publish(self, update: dict[str, Any]) -> None:
        for queue in tuple(self._subscribers):
            if queue.full():
                pending: list[dict[str, Any]] = []
                while not queue.empty():
                    pending.append(queue.get_nowait())
                queue.put_nowait(self._merge_events(pending, update))
                continue
            queue.put_nowait(update)


def _collect_changed_tables(session: Session, flush_context: object) -> None:
    changed = session.info.setdefault("_live_changed_tables", set())
    asset_ids = session.info.setdefault("_live_changed_asset_ids", set())
    entity_ids = session.info.setdefault("_live_changed_entity_ids", {})
    for instance in (*session.new, *session.dirty, *session.deleted):
        table_name = getattr(type(instance), "__tablename__", None)
        if table_name is None:
            continue
        changed.add(table_name)
        attributes = _ENTITY_ID_ATTRIBUTES.get(table_name, ("id",))
        ids = entity_ids.setdefault(table_name, set())
        for attribute in attributes:
            value = getattr(instance, attribute, None)
            if isinstance(value, int) and not isinstance(value, bool):
                ids.add(value)
                if attribute in {"asset_id", "target_asset_id"} or (
                    table_name == "assets" and attribute == "id"
                ):
                    asset_ids.add(value)


def _publish_committed_changes(session: Session) -> None:
    changed = session.info.pop("_live_changed_tables", set())
    asset_ids = session.info.pop("_live_changed_asset_ids", set())
    entity_ids = session.info.pop("_live_changed_entity_ids", {})
    hub = session.info.get("live_update_hub")
    if isinstance(hub, LiveUpdateHub):
        hub.publish_from_session(changed, asset_ids, entity_ids)


def _discard_rolled_back_changes(session: Session) -> None:
    session.info.pop("_live_changed_tables", None)
    session.info.pop("_live_changed_asset_ids", None)
    session.info.pop("_live_changed_entity_ids", None)


event.listen(Session, "after_flush", _collect_changed_tables)
event.listen(Session, "after_commit", _publish_committed_changes)
event.listen(Session, "after_rollback", _discard_rolled_back_changes)

#Keeping the Websocket alive
# This is the WebSocket handler that serves connected clients
async def serve_live_updates(
    websocket: WebSocket,
    hub: LiveUpdateHub,
    *,
    authorized_asset_ids: set[int] | None = None,
    authorization_check: Callable[
        [], Awaitable[tuple[bool, set[int] | None]]
    ] | None = None,
) -> None:
    await websocket.accept(subprotocol="nem-auth" if "nem-auth" in websocket.scope.get("subprotocols", []) else None)
    queue = hub.subscribe()

    async def receive_until_disconnected() -> None:
        while True:
            await websocket.receive_text()

    receiver = asyncio.create_task(receive_until_disconnected())
    try:
        while True:
            try:
                update = await asyncio.wait_for(queue.get(), timeout=25)
            except asyncio.TimeoutError:
                update = hub._event("heartbeat")
            if authorization_check is not None:
                authorized, authorized_asset_ids = await authorization_check()
                if not authorized:
                    await websocket.close(code=1008, reason="Session is invalid or expired")
                    return
            if authorized_asset_ids is not None:
                if update["type"] == "database_change":
                    visible_asset_ids = (set(update.get("asset_ids", ())) & authorized_asset_ids)
                    if visible_asset_ids:
                        update = {
                            **update,
                            "asset_ids": sorted(visible_asset_ids),
                            "entity_ids": {},
                            "critical_events": [],
                        }
                    elif update.get("resync_required"):
                        update = {
                            "type": "database_change",
                            "asset_ids": [],
                            "changed_tables": [],
                            "entity_ids": {},
                            "critical_events": [],
                            "resync_required": True,
                        }
                    else:
                        continue
                elif update["type"] == "opcua_status":
                    if not update.get("resync_required"):
                        continue
                    update = {
                        "type": "database_change",
                        "asset_ids": [],
                        "changed_tables": [],
                        "entity_ids": {},
                        "critical_events": [],
                        "resync_required": True,
                    }
                elif update.get("resync_required"):
                    update = {
                        "type": "database_change",
                        "asset_ids": [],
                        "changed_tables": [],
                        "entity_ids": {},
                        "critical_events": [],
                        "resync_required": True,
                    }
                elif update["type"] not in {"connected", "heartbeat"}:
                    continue
            await websocket.send_json(update)
    except WebSocketDisconnect:
        pass
    finally:
        receiver.cancel()
        await asyncio.gather(receiver, return_exceptions=True)
        hub.unsubscribe(queue)

#Bridge between the db changes and live frontend 