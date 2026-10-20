import logging # Records diagonostic messages without printing sensitive details
from dataclasses import dataclass # creates a convenient class for storing related data
from datetime import datetime
from urllib.parse import urlsplit

from asyncua import Client, ua # Provides the OPC UA client connection and protocol types
from app.core.config import Settings # application`s configuration class, which supplies connection settings

LOGGER = logging.getLogger("nem_backend.opcua")

#Tracking subscription settings
class _ConfiguredOpcUaClient(Client):
    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.last_subscription_result: ua.CreateSubscriptionResult | None = None

    def get_subscription_revised_params(self,
        params: ua.CreateSubscriptionParameters,
        results: ua.CreateSubscriptionResult,
    ) -> ua.ModifySubscriptionParameters | None:
        self.last_subscription_result = results
        return super().get_subscription_revised_params(params, results)
    
 #Separating configuration errors from communication errors
class OpcUaConfigurationError(RuntimeError):
    pass

#an OPC UA connection or reading operation failed.
class OpcUaConnectionError(RuntimeError):
    pass

@dataclass(frozen=True)
class OpcUaRead:
    value: object
    source_timestamp: datetime | None
    server_timestamp: datetime | None

# Validate the endpoint and optional username/password before connecting.
def _validate_connection_settings(settings: Settings) -> str:
    endpoint = settings.opcua_endpoint.strip()
    try:
        parsed_endpoint = urlsplit(endpoint)
        port = parsed_endpoint.port
    except ValueError as error:
        raise OpcUaConfigurationError("OPCUA_ENDPOINT is not a valid OPC UA endpoint URL.") from error
    if (
        parsed_endpoint.scheme.lower() != "opc.tcp"
        or not parsed_endpoint.hostname
        or port is None
        or parsed_endpoint.username is not None
        or parsed_endpoint.password is not None
        or parsed_endpoint.query
        or parsed_endpoint.fragment
    ):
        raise OpcUaConfigurationError("Set OPCUA_ENDPOINT to the opc.tcp:// endpoint supplied by the PLC engineer; do not place credentials in the URL.")

    username = settings.opcua_username.strip()
    password = settings.opcua_password.get_secret_value()
    if bool(username) != bool(password):
        raise OpcUaConfigurationError("Configure both OPCUA_USERNAME and OPCUA_PASSWORD, or leave both empty.")
    return endpoint

# function converts a low-level exception into a more controlled error message, without exposing sensitive information like credentials or file paths. It logs the error type for diagnostics while returning a generic connection error to the caller.

def _safe_connection_error(error: Exception) -> OpcUaConnectionError:
    LOGGER.error("OPC UA operation failed",exc_info=(type(error), error, error.__traceback__),)
    return OpcUaConnectionError(f"OPC UA operation failed ({type(error).__name__}).")

# Most importantly, this function connects to the OPC UA server, reads the value of a specified node, and returns it along with its timestamps. It handles configuration validation, security setup, and error management.
async def read_opcua_node(settings: Settings, node_id: str) -> OpcUaRead:
    try:
        client = await create_configured_opcua_client(settings)
       #Connect and read a node
        async with client:
            data_value = await client.get_node(node_id).read_data_value()
    except Exception as error:
        if isinstance(error, OpcUaConfigurationError):
            raise
        raise _safe_connection_error(error) from error
#Extract the returned value
    variant = data_value.Value
    if variant is None:
        raise OpcUaConnectionError("The OPC UA node returned no value.")
    return OpcUaRead(
        value=variant.Value,
        source_timestamp=data_value.SourceTimestamp,
        server_timestamp=data_value.ServerTimestamp,
    )

#Preparing the OPC UA client
async def create_configured_opcua_client(settings: Settings) -> Client:
    endpoint = _validate_connection_settings(settings)
    client = _ConfiguredOpcUaClient(url=endpoint,timeout=settings.opcua_timeout_seconds,)
    if settings.opcua_username.strip():
        client.set_user(settings.opcua_username.strip())
        client.set_password(settings.opcua_password.get_secret_value())

    return client

# test the connection to the OPC UA server by reading a well-known node (i=2258) that returns the server's current time. 
# This function is useful for verifying that the connection settings are correct and that the server is responsive.
async def test_opcua_connection(settings: Settings) -> dict[str, object]:
    result = await read_opcua_node(settings, "i=2258")
    server_time = result.value
    return {
        "connected": True,
        "endpoint": settings.opcua_endpoint.strip(),
        "test": "read_only",
        "server_time": server_time.isoformat() if isinstance(server_time, datetime) else str(server_time),
        "message": "Read-only OPC UA connection test succeeded without transport encryption.",
    }

# Handled communication with the PLC.
# Plc-> OPC UA server -> client module-> FastAPI backend and collector