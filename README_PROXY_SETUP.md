# Secure WebSocket Proxy for Live API Web Console

This project implements a secure WebSocket proxy that sits between the client and Google's Live API. This approach prevents exposing your API key directly in the frontend code, which is a security best practice for production applications.

## Architecture

```
Client <---> WebSocket Proxy Server <---> Google Gemini Live API
```

The proxy server securely stores the API key on the server side and relays WebSocket messages between the client and Google's API.

## Setup Instructions

### 1. Install Dependencies

First, make sure you have all the required dependencies:

```bash
npm install
```

### 2. Configure Environment Variables

Create a `.env` file in the root directory with your Gemini API key:

```
# .env
GEMINI_API_KEY=your_api_key_here
PORT=8080
```

**IMPORTANT**: Add `.env` to your `.gitignore` file to prevent accidentally committing your API key.

### 3. Running the Application

You have two options to run the application:

#### Option 1: Run both client and server with one command

```bash
npm run dev
```

This command uses concurrently to run both the React client (on port 3000) and the WebSocket proxy server (on port 8080).

#### Option 2: Run client and server separately

In one terminal, start the WebSocket proxy server:

```bash
npm run start-server
```

In another terminal, start the React client:

```bash
npm start
```

### 4. Using the Application

Once both the client and server are running, the client will automatically connect to the WebSocket proxy server, which will handle the secure connection to Google's Live API.

## Production Deployment

For production deployment, you need to:

1. Set the `GEMINI_API_KEY` environment variable securely in your production environment.
2. Build the React application with `npm run build`.
3. Deploy the WebSocket proxy server and the built React application on your server.
4. Set the `REACT_APP_PROXY_URL` environment variable to point to your deployed WebSocket proxy server URL. For example:
   ```
   REACT_APP_PROXY_URL=wss://your-production-domain.com
   ```

## Security Considerations

- The WebSocket proxy server should be deployed in a secure environment.
- Always use HTTPS (or WSS for WebSockets) in production.
- Regularly rotate your API keys as a best practice.
- Consider implementing additional security measures like rate limiting and request validation. 