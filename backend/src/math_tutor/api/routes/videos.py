"""
Video streaming routes - serves generated video files with Range support
"""
import logging
import os
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse, FileResponse

from ...config import get_settings

router = APIRouter()
logger = logging.getLogger(__name__)


def get_media_path() -> Path:
    """Get absolute path to media directory"""
    settings = get_settings()
    media_path = Path(settings.manim_output_dir)
    if not media_path.is_absolute():
        # Resolve relative to backend directory (where uvicorn runs)
        media_path = Path(os.getcwd()) / media_path
    return media_path


@router.get("/videos/{path:path}")
async def stream_video(path: str, request: Request):
    """
    Stream video file with Range request support for proper playback.
    
    This endpoint supports partial content (Range headers) which is required
    for video seeking and proper playback in browsers.
    """
    media_path = get_media_path()
    video_path = media_path / "videos" / path
    
    if not video_path.exists():
        logger.error(f"Video not found: {video_path}")
        raise HTTPException(status_code=404, detail="Video not found")
    
    if not video_path.is_file():
        raise HTTPException(status_code=400, detail="Invalid video path")
    
    file_size = video_path.stat().st_size
    
    # Check for Range header
    range_header = request.headers.get("range")
    
    if range_header:
        # Parse Range header: "bytes=start-end"
        try:
            range_spec = range_header.replace("bytes=", "")
            range_parts = range_spec.split("-")
            start = int(range_parts[0]) if range_parts[0] else 0
            end = int(range_parts[1]) if range_parts[1] else file_size - 1
        except (ValueError, IndexError):
            start = 0
            end = file_size - 1
        
        # Clamp values
        start = max(0, start)
        end = min(end, file_size - 1)
        content_length = end - start + 1
        
        def iter_file():
            with open(video_path, "rb") as f:
                f.seek(start)
                remaining = content_length
                chunk_size = 1024 * 1024  # 1MB chunks
                while remaining > 0:
                    read_size = min(chunk_size, remaining)
                    data = f.read(read_size)
                    if not data:
                        break
                    remaining -= len(data)
                    yield data
        
        return StreamingResponse(
            iter_file(),
            status_code=206,  # Partial Content
            media_type="video/mp4",
            headers={
                "Content-Range": f"bytes {start}-{end}/{file_size}",
                "Accept-Ranges": "bytes",
                "Content-Length": str(content_length),
            }
        )
    else:
        # No Range header - return full file
        return FileResponse(
            video_path,
            media_type="video/mp4",
            headers={
                "Accept-Ranges": "bytes",
                "Content-Length": str(file_size),
            }
        )
