"""
Unified logging configuration
"""
import logging
import sys
from typing import Literal


def setup_logging(
    level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO",
    format_string: str | None = None,
) -> None:
    """
    Setup unified logging configuration.
    
    Call this once at application startup. All modules should use:
        logger = logging.getLogger(__name__)
    """
    if format_string is None:
        format_string = "%(asctime)s | %(name)s | %(levelname)s | %(message)s"
    
    logging.basicConfig(
        level=getattr(logging, level),
        format=format_string,
        handlers=[
            logging.StreamHandler(sys.stdout),
        ],
        force=True,  # Override any existing configuration
    )
    
    # Reduce noise from third-party libraries
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
