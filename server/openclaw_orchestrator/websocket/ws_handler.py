"""WebSocket handler for real-time event broadcasting.

Uses FastAPI's WebSocket support. Clients connect to /ws endpoint.
The broadcast() function sends events to all connected clients.
Includes ping/pong heartbeat to detect and clean up dead connections.
"""

from __future__ import annotations

import asyncio
import json
import logging
from concurrent.futures import Future
from typing import Any

from fastapi import WebSocket

# Connected WebSocket clients
_clients: dict[WebSocket, float] = {}
_main_loop: asyncio.AbstractEventLoop | None = None
HEARTBEAT_INTERVAL = 15.0
HEARTBEAT_TIMEOUT = 45.0
logger = logging.getLogger(__name__)


async def handle_ws_connection(websocket: WebSocket) -> None:
    """Handle a new WebSocket connection."""
    global _main_loop

    await websocket.accept()
    loop = asyncio.get_running_loop()
    _main_loop = loop
    _clients[websocket] = loop.time()
    logger.info("WebSocket client connected (total: %d)", len(_clients))

    # Send welcome message
    await websocket.send_json(
        {
            "type": "connected",
            "payload": {"message": "Welcome to OpenClaw Orchestrator"},
            "timestamp": _now(),
        }
    )

    # Start heartbeat task for this connection
    heartbeat_task = asyncio.create_task(_heartbeat_loop(websocket))

    try:
        from openclaw_orchestrator.services.gateway_connector import gateway_connector
        gateway_payload = gateway_connector._build_gateway_status_payload(
            connected=gateway_connector.connected,
            error=gateway_connector.last_error,
        )

        await websocket.send_json(
            {
                "type": "gateway_status",
                "payload": gateway_payload,
                "timestamp": _now(),
            }
        )

        gateway_error = gateway_payload.get("error") if isinstance(gateway_payload, dict) else None
        if isinstance(gateway_error, str) and gateway_error.strip():
            event_timestamp = _now()
            communication_payload: dict[str, Any] = {
                "id": f"gateway-error-replay-{event_timestamp}",
                "fromAgentId": "gateway",
                "toAgentId": "gateway.error",
                "type": "broadcast",
                "eventType": "gateway.error",
                "content": gateway_error.strip(),
                "message": gateway_error.strip(),
                "error": gateway_error.strip(),
                "timestamp": event_timestamp,
            }
            code = gateway_payload.get("code")
            if isinstance(code, str) and code.strip():
                communication_payload["code"] = code.strip()
            if gateway_payload.get("authRequired"):
                communication_payload["authRequired"] = True

            await websocket.send_json(
                {
                    "type": "communication",
                    "payload": communication_payload,
                    "timestamp": event_timestamp,
                }
            )
    except Exception:
        pass

    try:
        while True:
            data = await websocket.receive_text()
            try:
                message = json.loads(data)
                await _handle_client_message(websocket, message)
            except json.JSONDecodeError:
                pass
    except Exception:
        pass
    finally:
        heartbeat_task.cancel()
        try:
            await heartbeat_task
        except asyncio.CancelledError:
            pass
        _clients.pop(websocket, None)
        logger.info("WebSocket client disconnected (total: %d)", len(_clients))


async def _heartbeat_loop(websocket: WebSocket) -> None:
    """Periodically send ping messages and check for pong responses."""
    try:
        loop = asyncio.get_running_loop()
        while True:
            await asyncio.sleep(HEARTBEAT_INTERVAL)

            # Check if client responded to last ping
            last_pong = _clients.get(websocket)
            if last_pong is not None:
                elapsed = loop.time() - last_pong
                if elapsed > HEARTBEAT_TIMEOUT:
                    logger.warning(
                        "WebSocket client heartbeat timeout (%.1fs), closing",
                        elapsed,
                    )
                    try:
                        await websocket.close(code=1000, reason="Heartbeat timeout")
                    except Exception:
                        pass
                    return

            # Send ping
            try:
                await websocket.send_json({
                    "type": "ping",
                    "timestamp": _now(),
                })
            except Exception:
                return
    except asyncio.CancelledError:
        pass


async def _handle_client_message(ws: WebSocket, message: Any) -> None:
    """Handle incoming client messages, including pong responses."""
    msg_type = message.get("type") if isinstance(message, dict) else None

    if msg_type == "pong":
        # Update last pong timestamp
        _clients[ws] = asyncio.get_running_loop().time()
        return

    logger.debug("Received client message: %s", message)


def broadcast(event: dict[str, Any]) -> None:
    """Broadcast an event to all connected WebSocket clients.

    Safe to call from both asyncio tasks and worker threads.
    """
    data = json.dumps(event, default=str)
    target_loop = _main_loop
    if target_loop is None or target_loop.is_closed():
        try:
            target_loop = asyncio.get_running_loop()
        except RuntimeError:
            return

    async def _do_broadcast() -> None:
        dead_clients: set[WebSocket] = set()
        for client in list(_clients):
            try:
                await client.send_text(data)
            except Exception:
                dead_clients.add(client)
        for dc in dead_clients:
            _clients.pop(dc, None)

    try:
        running_loop = asyncio.get_running_loop()
    except RuntimeError:
        running_loop = None

    if running_loop is target_loop:
        target_loop.create_task(_do_broadcast())
        return

    future: Future[None] = asyncio.run_coroutine_threadsafe(_do_broadcast(), target_loop)
    future.add_done_callback(_consume_future_exception)


def _consume_future_exception(future: Future[None]) -> None:
    try:
        future.exception()
    except Exception:
        pass


def _now() -> str:
    from datetime import UTC, datetime

    return datetime.now(UTC).isoformat()
