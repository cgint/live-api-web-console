/**
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MultimodalLiveClient } from "../lib/multimodal-live-client";
import { LiveConfig } from "../multimodal-live-types";
import { AudioStreamer } from "../lib/audio-streamer";
import { audioContext } from "../lib/utils";
import VolMeterWorket from "../lib/worklets/vol-meter";

export type UseLiveAPIResults = {
  client: MultimodalLiveClient;
  setConfig: (config: LiveConfig) => void;
  config: LiveConfig;
  connected: boolean;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  volume: number;
  connectionState: string;
  error: string | null;
};

export type UseLiveAPIProps = {
  proxyUrl: string;
};

// WebSocket status for logging
const WS_STATES = {
  0: 'CONNECTING',
  1: 'OPEN',
  2: 'CLOSING',
  3: 'CLOSED'
};

// Reconnection settings
const RECONNECT_INITIAL_DELAY = 1000;
const RECONNECT_MAX_DELAY = 30000;
const RECONNECT_MAX_ATTEMPTS = 5;

export function useLiveAPI({ proxyUrl }: UseLiveAPIProps): UseLiveAPIResults {
  // Instantiate client with proxyUrl
  const client = useMemo(
    () => new MultimodalLiveClient({ proxyUrl }),
    [proxyUrl] // Dependency is now only the proxyUrl
  );
  const audioStreamerRef = useRef<AudioStreamer | null>(null);

  const [connected, setConnected] = useState(false);
  const [connectionState, setConnectionState] = useState("disconnected");
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<LiveConfig>({
    model: "models/gemini-2.0-flash-exp",
  });
  const [volume, setVolume] = useState(0);

  // Reconnection state
  const reconnectAttempts = useRef(0);
  const reconnectTimeout = useRef<number | null>(null);
  const isReconnecting = useRef(false);
  const sessionHandle = useRef<string | null>(null);

  // Function refs to avoid circular dependencies in useEffect
  const connectFnRef = useRef<() => Promise<void>>();
  const disconnectFnRef = useRef<() => Promise<void>>();

  // Exponential backoff for reconnection
  const getReconnectDelay = useCallback(() => {
    const attempt = reconnectAttempts.current;
    const delay = Math.min(
      RECONNECT_INITIAL_DELAY * Math.pow(2, attempt),
      RECONNECT_MAX_DELAY
    );
    // Add some jitter to prevent all clients reconnecting simultaneously
    return delay + Math.random() * 1000;
  }, []);

  // register audio for streaming server -> speakers
  useEffect(() => {
    if (!audioStreamerRef.current) {
      audioContext({ id: "audio-out" }).then((audioCtx: AudioContext) => {
        audioStreamerRef.current = new AudioStreamer(audioCtx);
        audioStreamerRef.current
          .addWorklet<any>("vumeter-out", VolMeterWorket, (ev: any) => {
            setVolume(ev.data.volume);
          })
          .then(() => {
            // Successfully added worklet
          });
      });
    }
  }, [audioStreamerRef]);

  // Define the connect and disconnect functions
  const connect = useCallback(async () => {
    console.log("Attempting to connect via proxy with config:", config);
    if (!config) {
      console.error("Connection cancelled: config has not been set");
      setError("Config has not been set");
      throw new Error("config has not been set");
    }
    
    // Update connection state
    setConnectionState('connecting');
    setError(null);
    
    // Ensure any previous connection is closed before starting a new one
    if (client.ws && client.ws.readyState === WebSocket.OPEN) {
      console.log("Disconnecting existing connection before reconnecting...");
      await client.disconnect(); // Assuming disconnect is async or handles cleanup
      setConnected(false); // Ensure state reflects disconnected status
    }

    try {
      await client.connect(config);
      setConnected(true);
      setConnectionState('connected');
      console.log("Successfully connected via proxy.");
    } catch (error) {
      console.error("Failed to connect via proxy:", error);
      setConnected(false); // Ensure state is false on error
      setConnectionState('error');
      setError(error instanceof Error ? error.message : "Connection failed");
      throw error;
    }
  }, [client, config]);

  const disconnect = useCallback(async () => {
    console.log("Disconnecting from proxy...");
    
    // Clear any pending reconnect timeout
    if (reconnectTimeout.current !== null) {
      window.clearTimeout(reconnectTimeout.current);
      reconnectTimeout.current = null;
    }
    
    await client.disconnect();
    setConnected(false);
    setConnectionState('disconnected');
    setError(null);
  }, [client]);

  // Store function refs
  useEffect(() => {
    connectFnRef.current = connect;
    disconnectFnRef.current = disconnect;
  }, [connect, disconnect]);

  useEffect(() => {
    const onOpen = () => {
      console.log('useLiveAPI: WebSocket opened');
      setConnectionState('connected');
      setError(null);
      reconnectAttempts.current = 0;
      isReconnecting.current = false;
    };

    const onClose = (ev: CloseEvent) => { 
      console.log('useLiveAPI: WebSocket closed', ev.code, ev.reason);
      setConnected(false);
      setConnectionState('disconnected');
      
      // Check for specific close codes to handle reconnection strategy
      if (ev.code === 1000) {
        // Normal closure - no reconnect needed
        console.log('Normal closure, no reconnection needed');
        return;
      } else if (ev.code === 1012 || ev.code === 1013) {
        // Service restart (1012) or try again later (1013)
        // These are recoverable, so attempt to reconnect
        if (reconnectAttempts.current < RECONNECT_MAX_ATTEMPTS) {
          setConnectionState('reconnecting');
          const delay = getReconnectDelay();
          console.log(`Will attempt reconnection in ${Math.round(delay/1000)} seconds...`);
          
          if (reconnectTimeout.current !== null) {
            window.clearTimeout(reconnectTimeout.current);
          }
          
          reconnectTimeout.current = window.setTimeout(() => {
            reconnectAttempts.current++;
            isReconnecting.current = true;
            // Use the function ref instead of connect directly
            if (connectFnRef.current) {
              connectFnRef.current().catch((e) => {
                console.error('Reconnection attempt failed:', e);
                setError(`Reconnection failed: ${e.message || 'Unknown error'}`);
                setConnectionState('error');
                isReconnecting.current = false;
              });
            }
          }, delay);
        } else {
          setConnectionState('error');
          setError(`Maximum reconnection attempts (${RECONNECT_MAX_ATTEMPTS}) reached`);
        }
      } else {
        // Other error codes might not be recoverable
        setConnectionState('error');
        setError(`Connection closed: ${ev.reason || `Code ${ev.code}`}`);
      }
    };

    const onError = (error: Event) => {
      console.error('WebSocket error:', error);
      setConnectionState('error');
      setError('WebSocket connection error');
    };

    const onGoAway = (timeLeft: number) => {
      console.log(`Received GoAway, session will end in ${timeLeft}ms`);
      setConnectionState('reconnecting');
      
      // Store any session token we might have
      // If we have a session resumption token, we should close and reconnect cleanly
      if (sessionHandle.current) {
        console.log(`Will attempt to resume session with handle: ${sessionHandle.current}`);
        // Set a timeout to disconnect and reconnect before the server closes the connection
        if (reconnectTimeout.current !== null) {
          window.clearTimeout(reconnectTimeout.current);
        }
        
        reconnectTimeout.current = window.setTimeout(() => {
          // Use the function refs instead of direct references
          if (disconnectFnRef.current && connectFnRef.current) {
            disconnectFnRef.current().then(() => {
              // Update config with session resumption data
              const updatedConfig = {
                ...config,
                sessionResumption: {
                  handle: sessionHandle.current
                }
              };
              setConfig(updatedConfig);
              
              // Attempt to reconnect with the updated config
              isReconnecting.current = true;
              connectFnRef.current!().catch((e) => {
                console.error('Session resumption failed:', e);
                setError(`Session resumption failed: ${e.message || 'Unknown error'}`);
                setConnectionState('error');
                isReconnecting.current = false;
              });
            });
          }
        }, Math.max(0, timeLeft - 1000)); // Reconnect slightly before the server disconnects
      }
    };

    const onSessionUpdate = (handle: string) => {
      console.log(`Received session handle: ${handle}`);
      sessionHandle.current = handle;
    };

    const stopAudioStreamer = () => audioStreamerRef.current?.stop();

    const onAudio = (data: ArrayBuffer) =>
      audioStreamerRef.current?.addPCM16(new Uint8Array(data));

    client
      .on("open", onOpen) 
      .on("close", onClose)
      .on("error", onError)
      .on("goAway", onGoAway)
      .on("sessionUpdate", onSessionUpdate)
      .on("interrupted", stopAudioStreamer)
      .on("audio", onAudio);

    return () => {
      client
        .off("open", onOpen)
        .off("close", onClose)
        .off("error", onError)
        .off("goAway", onGoAway)
        .off("sessionUpdate", onSessionUpdate)
        .off("interrupted", stopAudioStreamer)
        .off("audio", onAudio);
      
      if (reconnectTimeout.current !== null) {
        window.clearTimeout(reconnectTimeout.current);
      }
    };
  // Use config, but remove direct references to connect/disconnect 
  // to avoid circular dependencies
  }, [client, config, getReconnectDelay]);

  return {
    client,
    config,
    setConfig,
    connected,
    connect,
    disconnect,
    volume,
    connectionState,
    error
  };
}
