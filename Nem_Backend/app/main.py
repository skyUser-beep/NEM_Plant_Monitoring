#Main entry point of the FastAPI backend
#app/main.py - Db,OPC UA collector , Maintenance scheduler , API routes -> React frontend
import logging
import asyncio #runs background tasks and manages async operations
from contextlib import asynccontextmanager #defines what happens when the app starts and shuts down
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, RedirectResponse
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import sessionmaker
from starlette.middleware.cors import CORSMiddleware
from starlette.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.api.routes import (
    assets,
    dashboard,
    frontend_compat,
    maintenance,
    monitoring,
    plc,
    readings,
    rules,
    variables,
)
from app.core.config import Settings, get_settings
from app.db.init_db import initialize_database
from app.db.session import create_database_engine, create_session_factory
from app.services.maintenance_schedule import emit_due_schedule_events
from app.services.monitoring_engine import acquire_scheduler_lease, utc_now
from app.services.opcua_collector import OpcUaCollector

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
    session_factory: sessionmaker = create_session_factory(engine)
    opcua_collector = OpcUaCollector(selected_settings, session_factory)

#Application startup and shutdown
    @asynccontextmanager
    async def lifespan(application: FastAPI):
        initialize_database(engine)
        opcua_collector.start()
        maintenance_due_task = None
        if selected_settings.maintenance_due_alerts_enabled:
            maintenance_due_task = asyncio.create_task(
                _maintenance_due_alert_loop(session_factory,owner_id=f"maintenance-{uuid4()}",),
                name="maintenance-due-alerts",)
        try:
            yield
        finally:
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

#Checking request size
    @application.middleware("http")
    async def enforce_request_size_limit(request: Request, call_next):
        content_length = request.headers.get("content-length")
        if content_length is not None:
            try:
                if int(content_length) > MAX_REQUEST_BODY_BYTES:
                    return JSONResponse(
                        status_code=413,
                        content={"error": {
                                "message": "Request body is too large",
                                "code": 413,
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
        return JSONResponse(status_code=422,
            content={"error": { "message": "Request validation failed",
                    "code": 422,"details": details,
                }
            },
        )
#HTTP exception handling
    @application.exception_handler(StarletteHTTPException)
    async def http_exception_handler(request: Request,error: StarletteHTTPException,) -> JSONResponse:
        if error.status_code == 413:
            return JSONResponse(
                status_code=413,
                content={
                    "error": {
                        "message": "Request body is too large",
                        "code": 413,
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
            return JSONResponse(
                status_code=503,
                content={
                    "status": "degraded",
                    "database": "disconnected",
                },
            )

        return JSONResponse(
            content={"status": "ok", "database": "connected"}
        )

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
            return JSONResponse(
                status_code=503,
                content={"status": "degraded", "database": "disconnected"},
            )
        return JSONResponse(content={"status": "ready", "database": "connected"})

    application.include_router(frontend_compat.router, prefix="/api/v1")
    application.include_router(assets.router, prefix="/api/v1")
    application.include_router(variables.router, prefix="/api/v1")
    application.include_router(readings.router, prefix="/api/v1")
    application.include_router(rules.router, prefix="/api/v1")
    application.include_router(monitoring.router, prefix="/api/v1")
    application.include_router(plc.router, prefix="/api/v1")
    application.include_router(maintenance.router, prefix="/api/v1")
    application.include_router(dashboard.router, prefix="/api/v1")
    frontend_directory = Path(__file__).resolve().parents[2] / "Nem_Frontend" / "dist"
    if frontend_directory.is_dir():
        application.mount(
            "/ui",
            FrontendStaticFiles(directory=str(frontend_directory), html=True),
            name="dashboard-ui",
        )
    application.add_api_route(
        "/plc/test",
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