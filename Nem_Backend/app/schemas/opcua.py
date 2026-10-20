#Pydantic schemas for OPC UA requests,responses, and machine signal mappings
from typing import Any
from pydantic import Field, field_validator, model_validator
from app.schemas.common import ORMModel
from app.schemas.reading import ReadingRead

#Request to read a PLC tag
class OpcUaReadRequest(ORMModel):
    node_id: str = Field(min_length=1, max_length=512)
    asset_id: int = Field(gt=0)
    variable_id: int = Field(gt=0)
    source_id: str | None = Field(default=None, max_length=200)

    @field_validator("node_id")
    @classmethod
    def nonempty_node_id(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("NodeId cannot be empty")
        return value
#Result of a read
class OpcUaReadResponse(ORMModel):
    node_id: str
    value: Any
    reading: ReadingRead

#Connect a plc tag to a db variables
class OpcUaTagMapping(ORMModel):
    node_id: str = Field(min_length=1, max_length=512)
    variable_id: int = Field(gt=0)

    @field_validator("node_id")
    @classmethod
    def nonempty_node_id(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("NodeId cannot be empty")
        return value

#Configure the signals for one machine
class OpcUaMachineMapping(ORMModel):
    asset_id: int = Field(gt=0)
    cycle_signal: OpcUaTagMapping | None = None
    running_signal: OpcUaTagMapping | None = None
    readings: list[OpcUaTagMapping] = Field(default_factory=list, max_length=64)
    cycle_limit: int | None = Field(default=None, gt=0)
    runtime_limit_seconds: int | None = Field(default=None, gt=0)

    @model_validator(mode="after")
    def validate_signals(self):
        signals = [
            signal
            for signal in (self.cycle_signal, self.running_signal)
            if signal is not None
        ] + self.readings
        if not signals:
            raise ValueError("At least one OPC UA signal or reading mapping is required")
        node_ids = [signal.node_id for signal in signals]
        if len(node_ids) != len(set(node_ids)):
            raise ValueError("NodeIds must be unique within a machine mapping")
        if self.cycle_limit is not None and self.cycle_signal is None:
            raise ValueError("A cycle limit requires a cycle signal")
        if self.runtime_limit_seconds is not None and self.running_signal is None:
            raise ValueError("A runtime limit requires a running signal")
        return self

#