#Plc/OPC UA API  router 
from datetime import datetime, timezone
import math

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from asyncua import ua
from pydantic import ValidationError #Catched Pydantic validation failures
from sqlalchemy.orm import Session # Represents the SQLAlchemy database session

# connect this router to your application`s own modules
from app.db.session import get_db
from app.schemas.opcua import OpcUaReadRequest, OpcUaReadResponse # Request and Response 
from app.schemas.reading import ReadingCreate, ReadingRead # reading before ingestion and how reading is represented in API response
import asyncio
from uuid import uuid4
from fastapi import HTTPException, Query, Request
from asyncua import ua

_discovery_jobs={}
_discovery_lock=asyncio.Lock()

from app.services.opcua_client import (OpcUaConfigurationError,OpcUaConnectionError,
    read_opcua_node, 
    test_opcua_connection,
    create_configured_opcua_client,
)
from app.services.reading_ingestion import ingest_reading
from app.services.opcua_collector import machine_status_rows

import logging
import traceback

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/plc", tags=["PLC / OPC UA"])
#Checking monitoring status
@router.get("/status")
def plc_monitoring_status(request: Request,session: Session = Depends(get_db),) -> dict[str, object]:
    collector = request.app.state.opcua_collector
    connection = dict(collector.status)
    last_notification_at = connection["last_notification_at"]
    connection["stale"] = (
        last_notification_at is None
        or (
            datetime.now(timezone.utc) - last_notification_at
        ).total_seconds()> request.app.state.settings.monitoring_default_stale_after_seconds
    )
    connection["stale_after_seconds"] = (request.app.state.settings.monitoring_default_stale_after_seconds)
    connection["requested_publishing_interval_ms"] = (request.app.state.settings.opcua_subscription_publishing_interval_ms)
    return {
        "connection": connection,
        "mapping_bypass_enabled": request.app.state.settings.opc_ua_mapping_bypass_enabled,
        "mappings": collector.configured_mapping_rows(session),
        "machines": machine_status_rows(
            session,
            collector,
            stale_after_seconds=request.app.state.settings.monitoring_default_stale_after_seconds,
        ),
    }

#Translate internal errors into HTTP errors
def opcua_http_error(error: Exception) -> HTTPException:
    if isinstance(error, OpcUaConfigurationError):
        return HTTPException(status_code=503, detail=str(error))
    return HTTPException(status_code=502, detail=str(error))

#Test the PLC connection
@router.get("/test")
async def plc_connection_test(request: Request) -> dict[str, object]:
    try:
        return await test_opcua_connection(request.app.state.settings)
    except (OpcUaConfigurationError, OpcUaConnectionError) as error:
        raise opcua_http_error(error) from error


#Discover the PLC nodes
@router.post("/discover")
async def start_opcua_discovery(
    request: Request,
    max_nodes: int = Query(default=200, ge=1, le=2000),
    max_depth: int = Query(default=5, ge=1, le=15),
):
    settings = request.app.state.settings
    job_id = str(uuid4())

    async with _discovery_lock:
        # Avoid starting multiple full scans simultaneously.
        running = any(job["status"] == "running"
            for job in _discovery_jobs.values()
        )
        if running:
            raise HTTPException(status_code=409,detail="A discovery job is already running.",)

        _discovery_jobs[job_id] = {
            "status": "running",
            "visited_nodes": 0,
            "variables": [],
            "error": None,
            "truncated": False,
        }
    async def scan():
        visited = set()
        variables = []
        stack = [(ua.ObjectIds.ObjectsFolder, 0)]
        visited_nodes = 0

        try:
            async with await create_configured_opcua_client(settings) as client:
                while stack and visited_nodes < max_nodes:
                    node_id, depth = stack.pop()
                    node = client.get_node(node_id)
                    key = node.nodeid.to_string()

                    if key in visited:
                        continue
                    visited.add(key)
                    visited_nodes += 1
                    try:
                        node_class = await node.read_node_class()
                        if node_class in (
                            ua.NodeClass.Object,
                            ua.NodeClass.View,
                        ) and depth < max_depth:
                            children = await node.get_children()
                            for child in reversed(children):
                                if child.nodeid.to_string() not in visited:
                                    stack.append((child.nodeid, depth + 1))

                        elif node_class == ua.NodeClass.Variable:
                            browse_name = await node.read_browse_name()
                            data_type = await node.read_data_type()

                            variables.append({
                                "node_id": key,
                                "browse_name": browse_name.Name,
                                "data_type_node_id": data_type.to_string(),
                                "readable": None,
                            })

                    except Exception:
                        logger.exception("Could not inspect OPC UA node %s",key,)
                        continue
                    # Yield control periodically so the event loop
                    # can serve other requests.
                    if visited_nodes % 20 == 0:
                        async with _discovery_lock:
                            _discovery_jobs[job_id].update({
                                "visited_nodes": visited_nodes,
                                "variables": list(variables),
                            })
                        await asyncio.sleep(0)

            async with _discovery_lock:
                _discovery_jobs[job_id].update({
                    "status": "completed",
                    "visited_nodes": visited_nodes,
                    "variables": variables,
                    "truncated": bool(stack),
                })

        except Exception as exc:
            logger.exception("OPC UA discovery failed for job %s",job_id,)
            async with _discovery_lock:
                _discovery_jobs[job_id].update({
                    "status": "failed",
                    "error": f"{type(exc).__name__}: {exc!r}",
                })
    asyncio.create_task(scan())
    return {
        "job_id": job_id,
        "status": "running",
        "message": "Discovery started in the background.",
    }

# Get discover results
@router.get("/discover/{job_id}")
async def get_opcua_discovery_result(job_id: str): # job_id is identifier created in discover function and used here to get the result of the discover results
    async with _discovery_lock:
        job = _discovery_jobs.get(job_id)

        if job is None:
            raise HTTPException(status_code=404,detail="Discovery job not found.",)

        return {
            "job_id": job_id,
            "status": job["status"],
            "visited_nodes": job["visited_nodes"],
            "count": len(job["variables"]),
            "variables": job["variables"],
            "truncated": job["truncated"],
            "error": job["error"],
        }

# main endpoint read a PLC node and save it
@router.post("/read", response_model=OpcUaReadResponse, status_code=201)
async def read_plc_value(
    payload: OpcUaReadRequest,
    request: Request,
    session: Session = Depends(get_db),
) -> dict[str, object]:
    #Read the requested PLC node
    try:
        plc_value = await read_opcua_node(request.app.state.settings, payload.node_id)
    except (OpcUaConfigurationError, OpcUaConnectionError) as error:
        raise opcua_http_error(error) from error

# Reject non-finite floating point-values

    value = plc_value.value
    if isinstance(value, float) and not math.isfinite(value):
        raise HTTPException(status_code=422, detail="OPC UA returned a non-finite numeric value")
    recorded_at = plc_value.source_timestamp or plc_value.server_timestamp or datetime.now(timezone.utc)
    # Validate the reading using ReadingCreate
    try:
        reading_payload = ReadingCreate(
            asset_id=payload.asset_id,
            variable_id=payload.variable_id,
            value=value,
            recorded_at=recorded_at,
            source_id=payload.source_id or "opcua",
            metadata={
                "protocol": "opc.tcp",
                "node_id": payload.node_id,
                "source_timestamp": (
                    plc_value.source_timestamp.isoformat() if plc_value.source_timestamp else None
                ),
                "server_timestamp": (
                    plc_value.server_timestamp.isoformat() if plc_value.server_timestamp else None
                ),
            },
        )
    except ValidationError as error:
        raise HTTPException(status_code=422,detail="OPC UA value cannot be represented by the selected variable's supported data type.",) from error

# Pass the reading to the ingestion service
    reading = ingest_reading(
        session,
        reading_payload,
        stale_after_seconds=request.app.state.settings.monitoring_default_stale_after_seconds,
    )
    return {
        "node_id": payload.node_id,
        "value": reading.value,
        "reading": ReadingRead.model_validate(reading),
    }

async def plc_connection_test_compat(request: Request) -> dict[str, object]:
    return await plc_connection_test(request)

# this file expose HTTP endpoints so that client can request a plc connection test 

# Validate OPC UA status quality
# Verify the node-to-varibale mapping
# Understand transaction handling
# Separate polling from the HTTP request
# Review the HTTP response code