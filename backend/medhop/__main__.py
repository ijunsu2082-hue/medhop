"""`python -m medhop` (run from backend/): start the MedHop backend on port 8010."""
from __future__ import annotations

import logging
import sys

import uvicorn

from medhop.config import Settings
from medhop.server import MedHopCore, create_app

logger = logging.getLogger("medhop")


class _Server(uvicorn.Server):
    """Ends the long-lived streams as soon as a shutdown is requested, so shutdown is prompt and the
    drone link is always stopped cleanly (neutral axes first)."""

    def __init__(self, config: uvicorn.Config, core: MedHopCore) -> None:
        super().__init__(config)
        self._core = core

    def handle_exit(self, sig, frame) -> None:  # type: ignore[override]
        self._core.stopping.set()
        super().handle_exit(sig, frame)


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")
    try:
        settings = Settings.from_env()
        core = MedHopCore(settings)
    except (ValueError, RuntimeError) as exc:
        logger.error("cannot start: %s", exc)
        return 2
    logger.info("drone mode: %s, data dir: %s", settings.drone, settings.data_dir)
    if settings.drone == "real":
        logger.warning("REAL DRONE MODE (%s). A human pilot must hold manual control and emergency stop.",
                       settings.drone_ip)
    config = uvicorn.Config(
        create_app(core=core),
        host=settings.host,
        port=settings.port,
        log_level="info",
        timeout_graceful_shutdown=3,
    )
    try:
        _Server(config, core).run()
    except KeyboardInterrupt:
        pass   # uvicorn re-raises Ctrl-C after its own graceful shutdown
    finally:
        if core.started:
            # Only reached if the server died without running its shutdown: still leave the drone neutral.
            core.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
