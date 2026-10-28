#Main entry point of the FastAPI backend
#app/main.py - Db,OPC UA collector , Maintenance scheduler , API routes -> React frontend
import logging
import asyncio #runs background tasks and manages async operations
from contextlib import asynccontextmanager #defines what happens when the app starts and shuts down
from pathlib import Path
from urllib.parse import urlsplit
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request, WebSocket
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, RedirectResponse
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import sessionmaker
from sqlalchemy import delete, select
from starlette.middleware.cors import CORSMiddleware
from starlette.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.api.routes import (
    assets,
    auth,
    dashboard,
    frontend_compat,
    maintenance,
    monitoring,
    notifications,
    plc,
    readings,
    rules,
    variables,
)
from app.models import AuthSession, User
from app.services.auth_security import hash_session_token
from app.core.config import Settings, get_settings
from app.db.init_db import initialize_database
from app.db.session import create_database_engine, create_session_factory
from app.services.email_notifications import deliver_pending
from app.services.maintenance_schedule import emit_due_schedule_events
from app.services.monitoring_engine import (
    acquire_scheduler_lease,
    evaluate_rules,
    utc_now,
)
from app.services.opcua_collector import OpcUaCollector
from app.services.live_updates import LiveUpdateHub, serve_live_updates

LOGGER = logging.getLogger("nem_backend")
MAX_REQUEST_BODY_BYTES = 25 * 1024 * 1024  

#function run repeatedly in the background to check whether maintenance schedules are due
async def _maintenance_due_alert_loop(session_factory, owner_id: str) -> None:
    while True:
        try:
            #Run db work outside the event loop
            def evaluate_due_schedules() -> None:
                with session_factory() as session:
                    if not acquire_scheduler_lease(
                        session,
                        owner_id=owner_id,
                        now=utc_now(),
                        lease_seconds=90,
                        name="maintenance-due-alerts",
                    ):
                        return
                    #Generate due schedule events
                    emit_due_schedule_events(session, today=utc_now().date())

            await asyncio.to_thread(evaluate_due_schedules)
        except SQLAlchemyError:
            LOGGER.exception("Maintenance due-date evaluation failed")
        await asyncio.sleep(60)


async def _email_delivery_loop(session_factory, settings: Settings) -> None:
    while True:
        try:
            await asyncio.to_thread(deliver_pending, session_factory, settings)
        except Exception:
            LOGGER.exception("Email notification delivery loop failed")
        await asyncio.sleep(10)


async def _monitoring_evaluation_loop(
    session_factory,
    owner_id: str,
    *,
    interval_seconds: int,
    stale_after_seconds: int,
) -> None:
    while True:
        try:
            def evaluate_monitoring_rules() -> None:
                with session_factory() as session:
                    if not acquire_scheduler_lease(
                        session,
                        owner_id=owner_id,
                        now=utc_now(),
                        lease_seconds=max(90, interval_seconds * 3),
                        name="monitoring-evaluation",
                    ):
                        return
                    evaluate_rules(
                        session,
                        evaluated_at=utc_now(),
                        stale_after_seconds=stale_after_seconds,
                        respect_rule_intervals=True,
                    )
                    session.commit()

            await asyncio.to_thread(evaluate_monitoring_rules)
        except SQLAlchemyError:
            LOGGER.exception("Monitoring rule evaluation failed")
        await asyncio.sleep(interval_seconds)

#Serving the frontend help serve a built React frontend
class FrontendStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope):
        try:
            return await super().get_response(path, scope)
        except StarletteHTTPException as error:
            if error.status_code == 404 and not Path(path).suffix:
                return await super().get_response("index.html", scope)
            raise

#Building the application
def create_app(settings: Settings | None = None) -> FastAPI:
    selected_settings = settings or get_settings()
    engine = create_database_engine(selected_settings.database_url)
    live_updates = LiveUpdateHub()
    session_factory: sessionmaker = create_session_factory(engine,info={"live_update_hub": live_updates},)
    opcua_collector = OpcUaCollector(
        selected_settings,
        session_factory,
        status_changed=live_updates.publish_status,
    )
    live_updates.add_database_change_listener(opcua_collector.request_configuration_refresh)

#Application startup and shutdown
    @asynccontextmanager
    async def lifespan(application: FastAPI):
        live_updates.bind_loop(asyncio.get_running_loop())
        initialize_database(engine)
        opcua_collector.start()
        monitoring_task = None
        if selected_settings.monitoring_scheduler_enabled:
            monitoring_task = asyncio.create_task(
                _monitoring_evaluation_loop(
                    session_factory,
                    owner_id=f"monitoring-{uuid4()}",
                    interval_seconds=(selected_settings.monitoring_evaluation_interval_seconds),
                    stale_after_seconds=(selected_settings.monitoring_default_stale_after_seconds),
                ),
                name="monitoring-evaluation",
            )
        email_task = None
        if selected_settings.email_notifications_enabled:
            email_task = asyncio.create_task(
                _email_delivery_loop(session_factory, selected_settings),
                name="email-notifications",
            )
        maintenance_due_task = None
        if selected_settings.maintenance_due_alerts_enabled:
            maintenance_due_task = asyncio.create_task(
                _maintenance_due_alert_loop(session_factory,owner_id=f"maintenance-{uuid4()}",),
                name="maintenance-due-alerts",)
        try:
            yield
        finally:
            if monitoring_task is not None:
                monitoring_task.cancel()
                try:
                    await monitoring_task
                except asyncio.CancelledError:
                    pass
            if email_task is not None:
                email_task.cancel()
                try:
                    await email_task
                except asyncio.CancelledError:
                    pass
            if maintenance_due_task is not None:
                maintenance_due_task.cancel()
                try:
                    await maintenance_due_task
                except asyncio.CancelledError:
                    pass
            try:
                await opcua_collector.stop()
            finally:
                engine.dispose()

#Creating the FastAPI application
    application = FastAPI(
        title=selected_settings.app_name,
        description=("Phase 1 industrial asset monitoring API. Readings may include simulated sample data."),
        version="1.0.0",
        lifespan=lifespan,
    )

    application.state.engine = engine
    application.state.session_factory = session_factory
    application.state.settings = selected_settings
    application.state.opcua_collector = opcua_collector
    application.state.live_updates = live_updates

    @application.middleware("http")
    async def authenticate_api_request(request: Request, call_next):
        path = request.url.path
        policy_path = "/api/v1/plc/test" if path == "/plc/test" else path
        if not policy_path.startswith("/api/v1/") or policy_path in {
            "/api/v1/health",
            "/api/v1/ready",
            "/api/v1/auth/login",
        }:
            return await call_next(request)

        authorization = request.headers.get("authorization", "")
        scheme, _, token = authorization.partition(" ")
        if scheme.casefold() != "bearer" or not token.strip():
            return JSONResponse(status_code=401,content={"detail": "Authentication required"},headers={"WWW-Authenticate": "Bearer"},)

        token_hash = hash_session_token(token.strip())
        with session_factory() as db:
            auth_session = db.scalar(select(AuthSession).where(AuthSession.token_hash == token_hash))
            now = utc_now()
            user = auth_session.user if auth_session is not None else None
            if (
                auth_session is None
                or auth_session.expires_at <= now
                or user is None
                or not user.is_active
            ):
                if auth_session is not None and auth_session.expires_at <= now:
                    db.delete(auth_session)
                    db.commit()
                return JSONResponse(status_code=401,content={"detail": "Session is invalid or expired"},headers={"WWW-Authenticate": "Bearer"},)

            role = user.role
            request.state.auth_user_id = user.id
            request.state.auth_token_hash = token_hash

        method = request.method.upper()
        safe_method = method in {"GET", "HEAD", "OPTIONS"}
        admin_only_read_paths = (
            "/api/v1/auth/users",
            "/api/v1/plc",
            "/api/v1/collections",
            "/api/v1/import",
            "/api/v1/settings",
            "/api/v1/backups",
            "/api/v1/usage",
        )
        supervisor_content_create = (
            role == "Supervisor"
            and method == "POST"
            and policy_path in {
                "/api/v1/rule-template-requests",
                "/api/v1/documents",
                "/api/v1/documents/with-files",
                }
                )
                
        supervisor_rule_template_update = (
            role == "Supervisor"
            and method == "PUT"
            and policy_path.startswith("/api/v1/rule-templates/")
            and len(policy_path.rstrip("/").split("/")) == 5
        )
        supervisor_plc_status_read = (
            role == "Supervisor"
            and method in {"GET", "HEAD"}
            and policy_path == "/api/v1/plc/status"
        )
        admin_only_write = (
            (policy_path == "/api/v1/assets" and not safe_method)
            or policy_path.startswith("/api/v1/assets/")
            and not any(segment in policy_path for segment in ("/rules", "/logbook"))
            and method in {"PATCH", "DELETE"}
            or policy_path.startswith("/api/v1/variables")
            or policy_path.startswith("/api/v1/plc")
            or policy_path.startswith("/api/v1/rule-templates")
            and not (
                (role == "Supervisor" and method == "POST" and policy_path.endswith("/assign"))
                or supervisor_content_create
                or supervisor_rule_template_update
            )
            or policy_path.startswith("/api/v1/collections")
            or policy_path.startswith("/api/v1/documents")
            or policy_path.startswith("/api/v1/import")
            or policy_path.startswith("/api/v1/settings")
            or policy_path.startswith("/api/v1/backups")
            or policy_path.startswith("/api/v1/usage")
            or policy_path == "/api/v1/monitoring/evaluate"
            or policy_path.startswith("/api/v1/readings") and not safe_method
            or policy_path.startswith("/api/v1/auth/users/")
            and method == "DELETE"
        )
        if (
            role != "Administrator"
            and policy_path.startswith(admin_only_read_paths)
            and policy_path != "/api/v1/auth/logout"
            and not supervisor_plc_status_read
        ):
            return JSONResponse(status_code=403,content={"detail": "Administrator permissions required"},)
        supervisor_write_paths = (
            (
                policy_path.startswith("/api/v1/maintenance")
                or policy_path.startswith("/api/v1/rules")
            )
            and method in {"POST", "PATCH", "DELETE"}
            and not policy_path.endswith("/permanent")
            or policy_path.startswith("/api/v1/assets/")
            and ("/rules" in policy_path or "/logbook" in policy_path)
            and method in {"POST", "PATCH", "DELETE"}
            and not policy_path.endswith("/permanent")
            or policy_path.startswith("/api/v1/alerts/")
            and method == "POST"
            and policy_path.endswith(("/acknowledge", "/complete"))
            or policy_path.startswith("/api/v1/rule-templates/")
            and method == "POST"
            and policy_path.endswith("/assign")
            or supervisor_content_create
            or supervisor_rule_template_update
        )
        if (
            role == "Supervisor"
            and not safe_method
            and policy_path != "/api/v1/auth/logout"
            and (
                (
                    admin_only_write
                    and not supervisor_content_create
                    and not supervisor_rule_template_update
                )
                or not supervisor_write_paths
            )
        ):
            return JSONResponse(status_code=403,content={"detail": "This action is not available to supervisors"},)
        if (
            role == "Operator"
            and not safe_method
            and policy_path != "/api/v1/auth/logout"
        ):
            operator_acknowledge = (
                policy_path.startswith("/api/v1/alerts/")
                and method == "POST"
                and policy_path.endswith(("/acknowledge", "/complete"))
            )
            policy_segments = policy_path.split("/")
            operator_maintenance_action = (
                method == "POST"
                and len(policy_segments) == 6
                and policy_segments[:4] == ["", "api", "v1", "maintenance"]
                and policy_segments[4].isdecimal()
                and policy_segments[5] in {"start", "complete"}
            )
            if admin_only_write or not (operator_acknowledge or operator_maintenance_action):
                return JSONResponse(status_code=403,content={
                        "detail": (
                            "Operators may acknowledge or complete resolved alerts, "
                            "or start and complete scheduled maintenance due today or overdue."
                        )
                    },
                )

        return await call_next(request)

    @application.websocket("/api/v1/live")
    @application.websocket("/api/v1/ws/live")
    async def live_updates_websocket(websocket: WebSocket) -> None:
        origin = websocket.headers.get("origin")
        if origin:
            try:
                parsed_origin = urlsplit(origin)
            except ValueError:
                await websocket.close(code=1008, reason="Origin is not allowed")
                return
            same_origin = parsed_origin.netloc.casefold() == (websocket.headers.get("host", "").casefold())
            configured_origin = origin.rstrip("/") in {
                configured.rstrip("/")
                for configured in selected_settings.allowed_origins
            }
            if not same_origin and not configured_origin:
                await websocket.close(code=1008, reason="Origin is not allowed")
                return
        offered_protocols = websocket.scope.get("subprotocols", [])
        token = next(
            (
                protocol.removeprefix("nem-auth.")
                for protocol in offered_protocols
                if protocol.startswith("nem-auth.")
            ),
            "",
        )
        if not token:
            await websocket.close(code=1008, reason="Authentication required")
            return
        with session_factory() as db:
            auth_session = db.scalar(select(AuthSession).where(AuthSession.token_hash == hash_session_token(token)))
            user = auth_session.user if auth_session is not None else None
            if (
                auth_session is None
                or auth_session.expires_at <= utc_now()
                or user is None
                or not user.is_active
            ):
                await websocket.close(code=1008, reason="Session is invalid or expired")
                return
        async def reauthorize_socket() -> tuple[bool, set[int] | None]:
            def read_current_access() -> tuple[bool, set[int] | None]:
                with session_factory() as db:
                    current_session = db.scalar(select(AuthSession).where(AuthSession.token_hash == hash_session_token(token)))
                    current_user = (current_session.user if current_session is not None else None)
                    if (
                        current_session is None
                        or current_session.expires_at <= utc_now()
                        or current_user is None
                        or not current_user.is_active
                    ):
                        return False, None
                    return True, None

            return await asyncio.to_thread(read_current_access)

        await serve_live_updates(
            websocket,
            live_updates,
            authorized_asset_ids=None,
            authorization_check=reauthorize_socket,
        )

#Checking request size
    @application.middleware("http")
    async def enforce_request_size_limit(request: Request, call_next):
        content_length = request.headers.get("content-length")
        if content_length is not None:
            try:
                if int(content_length) > MAX_REQUEST_BODY_BYTES:
                    return JSONResponse(status_code=413,content={"error": {"message": "Request body is too large","code": 413,
                            }
                        },
                    )
            except ValueError:
                pass
        return await call_next(request)
#CORS- allowing the frontend to call the backend (Cross-origin resource sharing)
    if selected_settings.allowed_origins:
        application.add_middleware(
            CORSMiddleware,
            allow_origins=selected_settings.allowed_origins,
            allow_credentials=True,
            allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
            allow_headers=["Authorization", "Content-Type"],
        )
#Global db error handling
    @application.exception_handler(SQLAlchemyError)
    async def database_error_handler(request: Request,error: SQLAlchemyError,) -> JSONResponse:
        LOGGER.error("Database operation failed for %s",
            request.url.path,
            exc_info=(type(error), error, error.__traceback__),
        )
        return JSONResponse(status_code=503,content={"detail": "Database operation failed; please retry"},)

#Request validation error handling
    @application.exception_handler(RequestValidationError)
    async def validation_exception_handler(request: Request,error: RequestValidationError,) -> JSONResponse:
        details = []
        for item in error.errors():
            clean_item = dict(item)
            ctx = clean_item.get("ctx")
            if isinstance(ctx, dict):
                clean_item["ctx"] = {
                    key: str(value) if isinstance(value, Exception) else value
                    for key, value in ctx.items()
                }
            details.append(clean_item)
        return JSONResponse(status_code=422,content={"error": { "message": "Request validation failed", "code": 422,"details": details,
                }
            },
        )
#HTTP exception handling
    @application.exception_handler(StarletteHTTPException)
    async def http_exception_handler(request: Request,error: StarletteHTTPException,) -> JSONResponse:
        if error.status_code == 413:
            return JSONResponse(status_code=413,content={"error": {"message": "Request body is too large","code": 413,
                    }
                },
            )
        if error.status_code == 409:
            return JSONResponse(status_code=409,content={"error": {"message": str(error.detail), "code": 409}},)
        return JSONResponse( status_code=error.status_code, content={"detail": error.detail},)
#Health and readiness endpoints
    @application.get("/health", tags=["health"])
    def health() -> JSONResponse:
        try:
            with session_factory() as session:
                session.execute(text("SELECT 1"))
        except SQLAlchemyError:
            LOGGER.exception("Database health check failed")
            return JSONResponse(status_code=503,content={"status": "degraded","database": "disconnected",
                },
            )
        return JSONResponse(content={"status": "ok", "database": "connected"})

    @application.get("/api/v1/health")
    def api_health() -> JSONResponse:
        return JSONResponse(content={"status": "ok"})

    @application.get("/api/v1/ready")
    def api_ready() -> JSONResponse:
        try:
            with session_factory() as session:
                session.execute(text("SELECT 1"))
        except SQLAlchemyError:
            LOGGER.exception("Database readiness check failed")
            return JSONResponse(status_code=503,content={"status": "degraded", "database": "disconnected"},)
        return JSONResponse(content={"status": "ready", "database": "connected"})

    application.include_router(auth.router, prefix="/api/v1")
    application.include_router(frontend_compat.router, prefix="/api/v1")
    application.include_router(assets.router, prefix="/api/v1")
    application.include_router(variables.router, prefix="/api/v1")
    application.include_router(readings.router, prefix="/api/v1")
    application.include_router(rules.router, prefix="/api/v1")
    application.include_router(monitoring.router, prefix="/api/v1")
    application.include_router(notifications.router, prefix="/api/v1")
    application.include_router(plc.router, prefix="/api/v1")
    application.include_router(maintenance.router, prefix="/api/v1")
    application.include_router(dashboard.router, prefix="/api/v1")
    frontend_directory = Path(__file__).resolve().parents[2] / "Nem_Frontend" / "dist"
    if frontend_directory.is_dir():
        application.mount("/ui",FrontendStaticFiles(directory=str(frontend_directory), html=True),name="dashboard-ui",)

    application.add_api_route("/plc/test",
        plc.plc_connection_test_compat,
        methods=["GET"],
        tags=["PLC / OPC UA"],
        include_in_schema=False,
    )
    @application.get("/", include_in_schema=False)
    def dashboard_home() -> RedirectResponse:
        destination = "/ui/" if frontend_directory.is_dir() else "/docs"
        return RedirectResponse(url=destination)

    return application

app = create_app()