FROM python:3.12-slim

WORKDIR /app

# System dependencies for Manim + ffmpeg (also needed by inspect_video frame extraction)
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        libcairo2-dev \
        libpango1.0-dev \
        ffmpeg \
        curl \
    && rm -rf /var/lib/apt/lists/*

# Copy project metadata first (better layer caching)
COPY pyproject.toml ./

# Copy source
COPY src/ ./src/

# Install the package in editable mode
RUN pip install --no-cache-dir -e .

# Persistent storage directories — actually mounted as volumes in compose,
# but creating them upfront avoids permission issues on first run.
RUN mkdir -p /app/media /app/data

EXPOSE 8000

# Run the application
CMD ["python", "-m", "math_tutor.api.main"]
