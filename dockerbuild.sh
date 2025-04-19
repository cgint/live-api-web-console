#!/bin/bash

# Exit immediately if a command exits with a non-zero status.
set -e
# Print commands and their arguments as they are executed.
set -x

# Define image name and tag
IMAGE_NAME="cgint/multimodal-live-api-web-console"
TAG="v2" # Or use a specific version, e.g., $(git rev-parse --short HEAD)

# Build the Docker image for linux/amd64 platform with plain progress
echo "Building Docker image for linux/amd64: $IMAGE_NAME:$TAG"
docker build --platform linux/amd64 --progress=plain -t "$IMAGE_NAME:$TAG" .

echo "Docker image built successfully: $IMAGE_NAME:$TAG"

# You can add commands here to push the image to a registry if needed
# Handle command line parameter
if [ "$1" = "push" ]; then
    echo "Pushing Docker image..."
    docker push "$IMAGE_NAME:$TAG"
elif [ "$1" = "run" ]; then
    echo "Running Docker container..."
    docker run -p 3000:3000 "$IMAGE_NAME:$TAG"
fi