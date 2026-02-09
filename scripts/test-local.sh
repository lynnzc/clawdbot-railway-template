#!/usr/bin/env bash
# Quick local test script for the OpenClaw Railway Template
set -e

echo "OpenClaw Railway Template - Local Test"
echo "=========================================="
echo ""

# Configuration
PORT=${PORT:-8080}
SETUP_PASSWORD=${SETUP_PASSWORD:-test123}
DATA_DIR=${DATA_DIR:-$(pwd)/.tmpdata}

echo "Configuration:"
echo "  PORT: $PORT"
echo "  SETUP_PASSWORD: $SETUP_PASSWORD"
echo "  DATA_DIR: $DATA_DIR"
echo ""

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo "Error: Docker is not running. Please start Docker and try again."
    exit 1
fi

echo "Building Docker image..."
docker build -t openclaw-railway-template:test .

echo ""
echo "Cleaning up previous containers..."
docker rm -f openclaw-test 2>/dev/null || true

echo ""
echo "Starting container..."
docker run --rm -d \
  --name openclaw-test \
  -p ${PORT}:8080 \
  -e PORT=8080 \
  -e SETUP_PASSWORD="${SETUP_PASSWORD}" \
  -e OPENCLAW_STATE_DIR=/data/.openclaw \
  -e OPENCLAW_WORKSPACE_DIR=/data/workspace \
  -v "${DATA_DIR}:/data" \
  openclaw-railway-template:test

echo ""
echo "Waiting for container to be healthy..."
sleep 3

# Check if container is running
if ! docker ps | grep -q openclaw-test; then
    echo "Container failed to start. Showing logs:"
    docker logs openclaw-test
    exit 1
fi

echo ""
echo "Container is running!"
echo ""
echo "Access the setup wizard at:"
echo "   http://localhost:${PORT}/setup"
echo ""
echo "Login credentials:"
echo "   Username: (any)"
echo "   Password: ${SETUP_PASSWORD}"
echo ""
echo "Other endpoints:"
echo "   Health check: http://localhost:${PORT}/setup/healthz"
echo "   Debug info:   http://localhost:${PORT}/setup/api/debug"
echo ""
echo "Container logs (live):"
echo "   docker logs -f openclaw-test"
echo ""
echo "To stop the container:"
echo "   docker stop openclaw-test"
echo ""
echo " To clean up test data:"
echo "   rm -rf ${DATA_DIR}"
echo ""

# Follow logs
echo "Following container logs (Ctrl+C to exit, container keeps running)..."
echo "---"
docker logs -f openclaw-test
