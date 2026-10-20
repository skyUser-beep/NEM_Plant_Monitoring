# component that continuously receives PLC updates,saves readings to the db 
# OPC UA server -> subscription handler -> OPC UA collector -> PostgreSQL and monitoring engine
import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

from fastapi import HTTPException
from pydantic import ValidationError # type: ignore
from sqlalchemy import and_, or_, select, update # type: ignore
from sqlalchemy.orm import Session, sessionmaker # type: ignore

from app.core.config import Settings
from app.models import (Alert,Asset,
    MachineMonitoringState,
    MonitoringRule,
    SchedulerLease,
    Variable,
)
from app.schemas.opcua import OpcUaMachineMapping
from app.schemas.reading import ReadingCreate
from app.services.monitoring_engine import (acquire_scheduler_lease,
    emit_event,evaluate_reading_rules,utc_now,
)
from app.services.opcua_client import (OpcUaConfigurationError,
    create_configured_opcua_client,
)
from app.services.reading_ingestion import ingest_reading

LOGGER = logging.getLogger("nem_backend.opcua.collector")
LEASE_NAME = "opcua-subscription-collector"
LEASE_SECONDS = 30
MAX_LEASE_SECONDS = 15 * 60

#The message received from the PLC
@dataclass(frozen=True)
class OpcUaNotification:
    node_id: str
    value: object
    recorded_at: datetime | None

#making timestamps consistent
def _normalize_notification_timestamp(
    recorded_at: datetime | None,
    node_id: str,
) -> datetime:
    """Treat naive OPC UA timestamps as UTC; use receipt time if none was supplied."""
    if recorded_at is None:
        LOGGER.warning(
            "OPC UA notification has no source or server timestamp; "
            "using collector receipt time for node=%s",
            node_id,
        )
        return utc_now()
    if recorded_at.tzinfo is None or recorded_at.utcoffset() is None:
        LOGGER.warning(
            "Naive OPC UA timestamp for node=%s; interpreting it as UTC",
            node_id,
        )
        return recorded_at.replace(tzinfo=timezone.utc)
    return recorded_at.astimezone(timezone.utc)

#reading the PLC configuration
def load_machine_mappings(raw: str) -> list[OpcUaMachineMapping]:
    if not raw.strip():
        return []
    try:
        payload = json.loads(raw)
        if not isinstance(payload, list):
            raise ValueError("OPCUA_MACHINE_MAPPINGS must be a JSON array")
        mappings = [OpcUaMachineMapping.model_validate(item) for item in payload]
    except (json.JSONDecodeError, ValidationError, ValueError) as error:
        raise OpcUaConfigurationError(
            "OPCUA_MACHINE_MAPPINGS must be a valid JSON array of machine mappings."
        ) from error

    assets: set[int] = set()
    node_ids: set[str] = set()
    for mapping in mappings:
        if mapping.asset_id in assets:
            raise OpcUaConfigurationError(
                "OPCUA_MACHINE_MAPPINGS must contain at most one entry per asset."
            )
        assets.add(mapping.asset_id)
        signals = [
            signal
            for signal in (mapping.cycle_signal, mapping.running_signal)
            if signal is not None
        ] + mapping.readings
        for signal in signals:
            if signal is None:
                continue
            if signal.node_id in node_ids:
                raise OpcUaConfigurationError(
                    "OPCUA_MACHINE_MAPPINGS must not map one NodeId more than once."
                )
            node_ids.add(signal.node_id)
    return mappings

#calculating machine running time
def advance_runtime(state: MachineMonitoringState, at: datetime) -> None:
    checkpoint = state.runtime_checkpoint_at
    if state.is_running is True and checkpoint is not None and at <= checkpoint:
        return
    if state.is_running is True and checkpoint is not None and at > checkpoint:
        state.accumulated_running_seconds = Decimal(
            state.accumulated_running_seconds
        ) + Decimal(str((at - checkpoint).total_seconds()))
    state.runtime_checkpoint_at = at if state.is_running is True else None
    state.updated_at = at


#Receiving PLC updates
class _SubscriptionHandler:
    def __init__(self,
        loop: asyncio.AbstractEventLoop,
        queue: asyncio.Queue[OpcUaNotification | None],
        max_queue_size: int,
    ) -> None:
        self._loop = loop
        self._queue = queue
        self._max_queue_size = max_queue_size
# how the notification callback works
    def datachange_notification(
        self,
        node: Any,
        value: object,
        data: Any,
    ) -> None:
        data_value = getattr(
            getattr(data, "monitored_item", None),
            "Value",
            None,
        )

        status = getattr(data_value, "StatusCode", None)
        if status is None or not status.is_good():
            LOGGER.warning("Ignoring OPC UA notification with bad or missing quality")
            return

        node_id = node.nodeid.to_string()
        source_timestamp = getattr(data_value, "SourceTimestamp", None)
        server_timestamp = getattr(data_value, "ServerTimestamp", None)

        LOGGER.warning("OPC UA RAW: node=%s value=%r quality=%s source=%r server=%r",
            node_id,
            value,
            status,
            source_timestamp,
            server_timestamp,
        )

        notification = OpcUaNotification(node_id=node_id,
            value=value,
            recorded_at=source_timestamp or server_timestamp,
        )

        def enqueue() -> None:
            if self._queue.qsize() >= self._max_queue_size:
                LOGGER.error(
                    "OPC UA notification queue is full; dropping a data change"
                )
                return
            self._queue.put_nowait(notification)

        self._loop.call_soon_threadsafe(enqueue)

    def status_change_notification(self, status: Any) -> None:
        LOGGER.warning("OPC UA subscription status changed (%s)",type(status).__name__,)

#preparing the collector
class OpcUaCollector:
    def __init__(self, settings: Settings, session_factory: sessionmaker[Session]) -> None:
        self.settings = settings
        self.session_factory = session_factory
        self.mappings = load_machine_mappings(settings.opcua_machine_mappings)
        self.status: dict[str, Any] = {
            "configured": bool(self.mappings),
            "state": "disconnected" if self.mappings else "disabled",
            "connected": False,
            "mapping_count": len(self.mappings),
            "last_connected_at": None,
            "last_notification_at": None,
            "last_error": None,
            "negotiated_publishing_interval_ms": None,
        }
        self._stop_event = asyncio.Event()
        self._task: asyncio.Task[None] | None = None
        self._owner_id = uuid.uuid4().hex
        self._node_mappings: dict[str, tuple[OpcUaMachineMapping, str, int]] = {}
        self._queue_size = max(len(self.mappings) * 20, 100)
        self._queue: asyncio.Queue[OpcUaNotification | None] | None = None

        for mapping in self.mappings:
            if mapping.cycle_signal is not None:
                self._node_mappings[mapping.cycle_signal.node_id] = (
                    mapping,
                    "cycle",
                    mapping.cycle_signal.variable_id,
                )
            if mapping.running_signal is not None:
                self._node_mappings[mapping.running_signal.node_id] = (
                    mapping,
                    "running",
                    mapping.running_signal.variable_id,
                )
            for signal in mapping.readings:
                self._node_mappings[signal.node_id] = (
                    mapping,
                    "reading",
                    signal.variable_id,
                )
#Checking mapping information for display
    def configured_mapping_rows(self, session: Session) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for mapping in self.mappings:
            asset = session.get(Asset, mapping.asset_id)
            signals = [
                (mapping.cycle_signal, "cycle_signal"),
                (mapping.running_signal, "running_signal"),
                *((signal, "reading") for signal in mapping.readings),
            ]
            for signal, role in signals:
                if signal is None:
                    continue
                variable = session.get(Variable, signal.variable_id)
                mapping_is_valid = (
                    asset is not None
                    and asset.is_active
                    and variable is not None
                    and variable.asset_id == mapping.asset_id
                    and variable.is_active
                    and (
                        role == "reading"
                        or variable.data_type == "boolean"
                    )
                )
                rows.append(
                    {
                        "asset_id": mapping.asset_id,
                        "asset_name": asset.name if asset else None,
                        "variable_id": signal.variable_id,
                        "variable_name": variable.name if variable else None,
                        "data_type": variable.data_type if variable else None,
                        "node_id": signal.node_id,
                        "role": role,
                        "asset_active": asset.is_active if asset else False,
                        "variable_active": (
                            variable.is_active if variable else False
                        ),
                        "mapping_valid": mapping_is_valid,
                        "variable_opcua_node_id": (
                            variable.opcua_node_id if variable else None
                        ),
                    }
                )
        return rows
#starting and stopping the collector
    def start(self) -> None:
        if not self.mappings:
            return
        if self._task is not None and not self._task.done():
            return
        self._stop_event.clear()
        self._task = asyncio.create_task(self._run(), name="opcua-subscription-collector")

    def prepare_startup(self) -> None:
        asset_ids = [mapping.asset_id for mapping in self.mappings]
        if not asset_ids:
            return
        with self.session_factory() as session:
            states = session.scalars(
                select(MachineMonitoringState).where(
                    MachineMonitoringState.asset_id.in_(asset_ids),
                    MachineMonitoringState.runtime_checkpoint_at.is_not(None)
                )
            ).all()
            for state in states:
                state.runtime_checkpoint_at = None
            session.commit()

    async def stop(self) -> None:
        self._stop_event.set()
        if self._queue is not None and not self._queue.full():
            self._queue.put_nowait(None)
        try:
            if self._task is not None:
                await self._task
                self._task = None
        finally:
            await asyncio.to_thread(self._release_lease)
            self.status["connected"] = False
            if self.mappings:
                self.status["state"] = "disconnected"

    async def _run(self) -> None:
        while not self._stop_event.is_set():
            try:
                if not await asyncio.to_thread(self._acquire_lease):
                    self.status.update(
                        state="standby",
                        connected=False,
                        last_error="Another application instance owns the OPC UA collector.",
                    )
                    await self._wait_before_retry()
                    continue
                await asyncio.to_thread(self.prepare_startup)
                await self._run_connection()
                if not self._stop_event.is_set():
                    raise ConnectionError("OPC UA subscription ended unexpectedly")
            except asyncio.CancelledError:
                raise
            except Exception as error:
                LOGGER.exception("OPC UA collector connection failed")
                self.status.update(
                    state="disconnected",
                    connected=False,
                    last_error=f"OPC UA collector unavailable ({type(error).__name__}).",
                )
                await asyncio.to_thread(self._release_lease)
                await self._wait_before_retry()

    async def _run_connection(self) -> None:
        await asyncio.to_thread(self._validate_mappings)
        self.status.update(state="connecting", connected=False, last_error=None)
        self.status["negotiated_publishing_interval_ms"] = None
        client = await create_configured_opcua_client(self.settings)
        async with client:
            loop = asyncio.get_running_loop()
            queue: asyncio.Queue[OpcUaNotification | None] = asyncio.Queue()
            self._queue = queue
            handler = _SubscriptionHandler(loop, queue, self._queue_size)
            requested_interval_ms = (
                self.settings.opcua_subscription_publishing_interval_ms
            )
            LOGGER.info(
                "Creating OPC UA subscription: requested_publishing_interval_ms=%s "
                "requested_sampling_interval_ms=50 requested_queue_size=0 "
                "monitored_node_count=%s node_ids=%s",
                requested_interval_ms,
                len(self._node_mappings),
                list(self._node_mappings),
            )
            subscription = await client.create_subscription(
                requested_interval_ms,
                handler,
            )
            subscription_result = getattr(client, "last_subscription_result", None)
            negotiated_interval_ms = getattr(
                subscription_result,
                "RevisedPublishingInterval",
                None,
            )
            self.status["negotiated_publishing_interval_ms"] = (
                negotiated_interval_ms
            )
            if negotiated_interval_ms is None:
                LOGGER.warning(
                    "OPC UA server's negotiated publishing interval is unavailable "
                    "through this client."
                )
            elif negotiated_interval_ms != requested_interval_ms:
                LOGGER.warning(
                    "OPC UA server revised publishing interval: "
                    "requested_publishing_interval_ms=%s "
                    "negotiated_publishing_interval_ms=%s",
                    requested_interval_ms,
                    negotiated_interval_ms,
                )
            else:
                LOGGER.info(
                    "OPC UA publishing interval negotiated as requested: "
                    "requested_publishing_interval_ms=%s "
                    "negotiated_publishing_interval_ms=%s",
                    requested_interval_ms,
                    negotiated_interval_ms,
                )
            nodes = [client.get_node(node_id) for node_id in self._node_mappings]
            await subscription.subscribe_data_change(nodes)
            now = utc_now()
            await asyncio.to_thread(self._connect_runtime, now)
            lease_renewal_interval = self._lease_seconds() / 3
            last_lease_renewal = time.monotonic()
            self.status.update(
                state="connected",
                connected=True,
                last_connected_at=now,
                last_error=None,
            )
            try:
                while not self._stop_event.is_set():
                    try:
                        notification = await asyncio.wait_for(
                            queue.get(),
                            timeout=self.settings.opcua_runtime_checkpoint_seconds,
                        )
                    except asyncio.TimeoutError:
                        if self._stop_event.is_set():
                            break
                        await client.check_connection()
                        if not await asyncio.to_thread(self._renew_lease):
                            raise ConnectionError("OPC UA collector lease was lost")
                        last_lease_renewal = time.monotonic()
                        await asyncio.to_thread(self._checkpoint_runtime, utc_now())
                        continue
                    if notification is None:
                        break
                    if (
                        time.monotonic() - last_lease_renewal
                        >= lease_renewal_interval
                    ):
                        if not await asyncio.to_thread(self._renew_lease):
                            raise ConnectionError("OPC UA collector lease was lost")
                        last_lease_renewal = time.monotonic()
                    await asyncio.to_thread(self._process_notification, notification)
            finally:
                await subscription.delete()
                self.status["negotiated_publishing_interval_ms"] = None
                await asyncio.to_thread(self._disconnect_runtime, utc_now())
                self._queue = None
                self.status["connected"] = False
#ensuring configuration matches the database
    def _validate_mappings(self) -> None:
        with self.session_factory() as session:
            for mapping in self.mappings:
                asset = session.get(Asset, mapping.asset_id)
                if asset is None or not asset.is_active:
                    raise OpcUaConfigurationError(f"OPC UA mapping references missing or inactive asset {mapping.asset_id}.")
                signals = [
                    (mapping.cycle_signal, True),
                    (mapping.running_signal, True),
                    *((signal, False) for signal in mapping.readings),
                ]
                for signal, is_state_signal in signals:
                    if signal is None:
                        continue
                    variable = session.get(Variable, signal.variable_id)
                    if (
                        variable is None
                        or variable.asset_id != mapping.asset_id
                        or not variable.is_active
                        or (is_state_signal and variable.data_type != "boolean")
                    ):
                        raise OpcUaConfigurationError("OPC UA NodeIds must map to active variables belonging to "
                            "their configured asset; cycle and running signals must be boolean."
                        )
#From plc updates to database
    def _process_notification(self, notification: OpcUaNotification) -> None:
        mapped = self._node_mappings.get(notification.node_id)
        if mapped is None:
            LOGGER.warning("Ignoring OPC UA notification for an unmapped NodeId")
            return
        mapping, role, variable_id = mapped
        if role in {"cycle", "running"} and not isinstance(notification.value, bool):
            LOGGER.warning("Ignoring non-boolean OPC UA %s signal for asset %s",role,mapping.asset_id,)
            return

        recorded_at = _normalize_notification_timestamp(notification.recorded_at,notification.node_id,)

        try:
            payload = ReadingCreate(
                asset_id=mapping.asset_id,
                variable_id=variable_id,
                value=notification.value,
                recorded_at=recorded_at,
                source_id="opcua_subscription",
                metadata={"protocol": "opc.tcp","node_id": notification.node_id,"signal": role,},)
            with self.session_factory() as session:
                state = session.get(MachineMonitoringState, mapping.asset_id)
                if state is None:
                    state = MachineMonitoringState(
                        asset_id=mapping.asset_id,
                        cycle_count=0,
                        accumulated_running_seconds=Decimal(0),
                        updated_at=recorded_at,
                    )
                    session.add(state)
                    session.flush()
                signal_at = (
                    state.last_cycle_signal_at if role == "cycle"
                    else state.last_running_signal_at if role == "running"
                    else None
                )
                if signal_at is not None and recorded_at < signal_at:
                    LOGGER.warning(
                        "Out-of-order OPC UA notification: "
                        "asset=%s node=%s role=%s value=%r "
                        "incoming_timestamp=%s previous_timestamp=%s",
                        mapping.asset_id,
                        notification.node_id,
                        role,
                        notification.value,
                        recorded_at.isoformat(),
                        signal_at.isoformat(),
                    )
                    return
                ingest_reading(
                    session,
                    payload,
                    stale_after_seconds=self.settings.monitoring_default_stale_after_seconds,
                    commit=False,
                )
                state.cycle_limit = mapping.cycle_limit
                state.runtime_limit_seconds = mapping.runtime_limit_seconds
                state.last_seen_at = max(state.last_seen_at or recorded_at, recorded_at)
                state.updated_at = recorded_at

                if role == "cycle":
                    previous_cycle_count = state.cycle_count
                    state.last_cycle_signal_at = recorded_at
                    self._apply_cycle_signal(session, state, notification.value, recorded_at)
                    if state.cycle_count > previous_cycle_count:
                        evaluate_reading_rules(session,
                            asset_id=mapping.asset_id,
                            variable_id=variable_id,
                            evaluated_at=recorded_at,
                            stale_after_seconds=(
                                self.settings.monitoring_default_stale_after_seconds
                            ),
                        )
                elif role == "running":
                    state.last_running_signal_at = recorded_at
                    self._apply_running_signal(session, state, notification.value, recorded_at)
                session.commit()
        except (HTTPException, ValidationError, ValueError) as error:
            LOGGER.warning(
                "Ignoring invalid OPC UA reading for asset %s (%s)",
                mapping.asset_id,
                type(error).__name__,
            )
            return
        self.status["last_notification_at"] = recorded_at

    @staticmethod
    def _apply_cycle_signal(session: Session,
        state: MachineMonitoringState,
        value: bool,
        at: datetime,
    ) -> None:
        previous = state.cycle_signal
        state.cycle_signal = value
        if previous is None or previous or not value:
            return
        state.cycle_count += 1
        state.last_cycle_at = at

    @staticmethod
    def _apply_running_signal(session: Session,
        state: MachineMonitoringState,
        value: bool,
        at: datetime,
    ) -> None:
        previous = state.is_running
        if previous is True:
            advance_runtime(state, at)
        state.is_running = value
        if value:
            if state.runtime_checkpoint_at is None or at > state.runtime_checkpoint_at:
                state.runtime_checkpoint_at = at
        else:
            state.runtime_checkpoint_at = None
        if previous is not True or value:
            return
        emit_event(
            session,
            event_type="machine_stopped",
            message=f"Machine stopped for asset {state.asset_id}.",
            occurred_at=at,
            asset_id=state.asset_id,
            metadata={"is_running": value},
        )

    def _connect_runtime(self, at: datetime) -> None:
        asset_ids = [mapping.asset_id for mapping in self.mappings]
        if not asset_ids:
            return
        with self.session_factory() as session:
            states = session.scalars(
                select(MachineMonitoringState).where(
                    MachineMonitoringState.asset_id.in_(asset_ids),
                    MachineMonitoringState.is_running.is_(True)
                )
            ).all()
            for state in states:
                state.runtime_checkpoint_at = at
                state.updated_at = at
            session.commit()

    def _checkpoint_runtime(self, at: datetime) -> None:
        asset_ids = [mapping.asset_id for mapping in self.mappings]
        if not asset_ids:
            return
        with self.session_factory() as session:
            states = session.scalars(
                select(MachineMonitoringState).where(
                    MachineMonitoringState.asset_id.in_(asset_ids),
                    MachineMonitoringState.is_running.is_(True),
                    MachineMonitoringState.runtime_checkpoint_at.is_not(None),
                )
            ).all()
            for state in states:
                advance_runtime(state, at)
            session.commit()

    def _disconnect_runtime(self, at: datetime) -> None:
        asset_ids = [mapping.asset_id for mapping in self.mappings]
        if not asset_ids:
            return
        with self.session_factory() as session:
            states = session.scalars(
                select(MachineMonitoringState).where(
                    MachineMonitoringState.asset_id.in_(asset_ids),
                    MachineMonitoringState.is_running.is_(True),
                    MachineMonitoringState.runtime_checkpoint_at.is_not(None),
                )
            ).all()
            for state in states:
                advance_runtime(state, at)
                state.runtime_checkpoint_at = None
            session.commit()
#lease management - preventing competing collectors
#attemps to claim ownership
    def _acquire_lease(self) -> bool:
        with self.session_factory() as session:
            return acquire_scheduler_lease(session,
                owner_id=self._owner_id,
                now=utc_now(),
                lease_seconds=self._lease_seconds(),
                name=LEASE_NAME,
            )
#calculate the lease duration using the configured timeouts
    def _lease_seconds(self) -> int:
        return min(
            MAX_LEASE_SECONDS,
            max(
                LEASE_SECONDS,
                self.settings.opcua_timeout_seconds * 3,
                self.settings.opcua_runtime_checkpoint_seconds * 3,
            ),
        )

    def _renew_lease(self) -> bool:
        return self._acquire_lease()
# expires the lease when the collector stops or loses its connection
    def _release_lease(self) -> None:
        released_at = utc_now()
        with self.session_factory() as session:
            session.execute(
                update(SchedulerLease)
                .where(
                    SchedulerLease.name == LEASE_NAME,
                    SchedulerLease.owner_id == self._owner_id,
                )
                .values(
                    lease_until=released_at,
                    updated_at=released_at,
                )
            )
            session.commit()
#waiting before reconnecting
    async def _wait_before_retry(self) -> None:
        try:
            await asyncio.wait_for(
                self._stop_event.wait(),
                timeout=self.settings.opcua_reconnect_delay_seconds,
            )
        except asyncio.TimeoutError:
            pass

#preparing machine status for the API
def machine_status_rows(
    session: Session,
    collector: OpcUaCollector | None,
    *,
    stale_after_seconds: int,
    now: datetime | None = None,
) -> list[dict[str, Any]]:
    current_time = now or utc_now()
    mappings = collector.mappings if collector is not None else []
    asset_ids = [mapping.asset_id for mapping in mappings]
    if not asset_ids:
        return []
    states = {
        state.asset_id: state
        for state in session.scalars(
            select(MachineMonitoringState).where(
                MachineMonitoringState.asset_id.in_(asset_ids)
            )
        ).all()
    }
    assets = {
        asset.id: asset
        for asset in session.scalars(
            select(Asset).where(Asset.id.in_(asset_ids))
        ).all()
    }
    alerts = session.scalars(
        select(Alert)
        .outerjoin(MonitoringRule, MonitoringRule.id == Alert.rule_id)
        .where(
            Alert.target_asset_id.in_(asset_ids),
            Alert.status == "active",
            or_(
                Alert.maintenance_schedule_id.is_not(None),
                and_(
                    MonitoringRule.is_enabled.is_(True),
                    MonitoringRule.is_archived.is_(False),
                ),
            ),
        )
        .order_by(Alert.started_at.desc(), Alert.id.desc())
    ).all()
    alerts_by_asset: dict[int, list[Alert]] = {asset_id: [] for asset_id in asset_ids}
    for alert in alerts:
        alerts_by_asset[alert.target_asset_id].append(alert)

    rows: list[dict[str, Any]] = []
    for mapping in mappings:
        state = states.get(mapping.asset_id)
        asset = assets.get(mapping.asset_id)
        last_seen_at = state.last_seen_at if state else None
        running_seconds = (
            Decimal(state.accumulated_running_seconds) if state else Decimal(0)
        )
        if (
            state is not None
            and state.is_running is True
            and state.runtime_checkpoint_at is not None
            and collector is not None
            and collector.status["connected"]
            and current_time > state.runtime_checkpoint_at
        ):
            running_seconds += Decimal(
                str((current_time - state.runtime_checkpoint_at).total_seconds())
            )
        rows.append(
            {
                "asset_id": mapping.asset_id,
                "asset_name": asset.name if asset else None,
                "status": (
                    "running" if state and state.is_running is True
                    else "stopped" if state and state.is_running is False
                    else "unknown"
                ),
                "is_running": state.is_running if state else None,
                "cycle_count": state.cycle_count if state else 0,
                "running_seconds": float(running_seconds),
                "cycle_limit": mapping.cycle_limit,
                "runtime_limit_seconds": mapping.runtime_limit_seconds,
                "last_cycle_at": state.last_cycle_at if state else None,
                "last_seen_at": last_seen_at,
                "stale": (
                    last_seen_at is None
                    or (current_time - last_seen_at).total_seconds() > stale_after_seconds
                ),
                "alerts": [
                    {
                        "id": alert.id,
                        "title": alert.title,
                        "severity": alert.severity,
                        "message": alert.message,
                        "started_at": alert.started_at,
                    }
                    for alert in alerts_by_asset[mapping.asset_id]
                ],
            }
        )
    return rows
#this file is the continuous monitoring engine between your plc and db