# Stage 1: Build the React application
FROM node:20-alpine AS builder

# Set the working directory
WORKDIR /app

# Copy package.json and package-lock.json (if available)
COPY package*.json ./

# Install dependencies (including devDependencies needed for build)
RUN npm install

# Copy the rest of the application source code
COPY public/ ./public/
COPY readme/ ./readme/
COPY *.json .
COPY *.yaml .
COPY src/ ./src/

# Build the application
RUN npm run build

# Stage 2: Serve the application using a lightweight Node.js server
FROM node:20-alpine

WORKDIR /app

# Install `serve` to statically serve the build folder
RUN npm install -g serve

# Copy the build output from the builder stage
COPY --from=builder /app/build ./build

# Expose the port the app will run on (serve defaults to 3000)
# Use ARG for build-time variable and ENV for runtime
ARG PORT=3000
ENV PORT=$PORT

EXPOSE $PORT

# Command to run the server
# -s flag handles single-page application routing
# -l specifies the port to listen on
CMD ["sh", "-c", "serve -s build -l ${PORT}"]