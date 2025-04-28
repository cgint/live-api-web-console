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

import { Content, GenerativeContentBlob, Part } from "@google/generative-ai";
import { EventEmitter } from "eventemitter3";
import { difference } from "lodash";
import {
  ClientContentMessage,
  isInterrupted,
  isModelTurn,
  isServerContentMessage,
  isSetupCompleteMessage,
  isToolCallCancellationMessage,
  isToolCallMessage,
  isTurnComplete,
  LiveIncomingMessage,
  ModelTurn,
  RealtimeInputMessage,
  ServerContent,
  SetupMessage,
  StreamingLog,
  ToolCall,
  ToolCallCancellation,
  ToolResponseMessage,
  type LiveConfig,
} from "../multimodal-live-types";
import { blobToJSON, base64ToArrayBuffer } from "./utils";

/**
 * Additional special message types that aren't in the standard types
 */
interface GoAwayMessage {
  goAway: {
    timeLeft: number;
  };
}

interface SessionResumptionUpdateMessage {
  sessionResumptionUpdate: {
    resumable: boolean;
    newHandle: string;
  };
}

// Type guard functions
function isGoAwayMessage(obj: any): obj is GoAwayMessage {
  return obj && 
         typeof obj === 'object' &&
         obj.goAway && 
         typeof obj.goAway === 'object' &&
         typeof obj.goAway.timeLeft === 'number';
}

function isSessionResumptionUpdateMessage(obj: any): obj is SessionResumptionUpdateMessage {
  return obj && 
         typeof obj === 'object' &&
         obj.sessionResumptionUpdate && 
         typeof obj.sessionResumptionUpdate === 'object' &&
         typeof obj.sessionResumptionUpdate.resumable === 'boolean' &&
         typeof obj.sessionResumptionUpdate.newHandle === 'string';
}

/**
 * the events that this client will emit
 */
interface MultimodalLiveClientEventTypes {
  open: () => void;
  log: (log: StreamingLog) => void;
  close: (event: CloseEvent) => void;
  error: (event: Event) => void;
  audio: (data: ArrayBuffer) => void;
  content: (data: ServerContent) => void;
  interrupted: () => void;
  setupcomplete: () => void;
  turncomplete: () => void;
  toolcall: (toolCall: ToolCall) => void;
  toolcallcancellation: (toolcallCancellation: ToolCallCancellation) => void;
  goAway: (timeLeft: number) => void;
  sessionUpdate: (handle: string) => void;
}

export type MultimodalLiveAPIClientConnection = {
  proxyUrl: string; // URL of YOUR backend proxy server
};

/**
 * A event-emitting class that manages the connection to the websocket and emits
 * events to the rest of the application.
 * If you dont want to use react you can still use this.
 */
export class MultimodalLiveClient extends EventEmitter<MultimodalLiveClientEventTypes> {
  public ws: WebSocket | null = null;
  protected config: LiveConfig | null = null;
  public proxyUrl: string = "";
  
  public getConfig() {
    return { ...this.config };
  }

  constructor({ proxyUrl }: MultimodalLiveAPIClientConnection) {
    super();
    if (!proxyUrl) {
      throw new Error("Proxy URL must be provided to MultimodalLiveClient");
    }
    this.proxyUrl = proxyUrl;
    this.send = this.send.bind(this);
  }

  log(type: string, message: StreamingLog["message"]) {
    const log: StreamingLog = {
      date: new Date(),
      type,
      message,
    };
    this.emit("log", log);
  }

  connect(config: LiveConfig): Promise<boolean> {
    this.config = config;

    // Connect to YOUR proxy server URL
    const ws = new WebSocket(this.proxyUrl);
    
    ws.addEventListener("error", (event: Event) => {
      this.emit("error", event);
    });

    ws.addEventListener("message", async (evt: MessageEvent) => {
      if (evt.data instanceof Blob) {
        this.receive(evt.data);
      } else if (typeof evt.data === 'string') {
        // Handle potential text messages from proxy (e.g., errors)
        console.warn("Received text message from proxy:", evt.data);
        // Potentially parse if expecting JSON errors, etc.
        try {
            const data = JSON.parse(evt.data);
            // Handle parsed data if necessary
            
            // Check for session-related messages
            if (isSessionResumptionUpdateMessage(data)) {
              this.emit("sessionUpdate", data.sessionResumptionUpdate.newHandle);
            }
            
            // Check for GoAway messages
            if (isGoAwayMessage(data)) {
              this.emit("goAway", data.goAway.timeLeft);
            }
        } catch (e) {
            // Ignore if not JSON or handle as plain text
        }
      } else {
        console.log("Received non-blob/non-string message:", evt);
      }
    });
    
    return new Promise((resolve, reject) => {
      const onError = (ev: Event) => {
        this.disconnect(ws);
        // Update error message to reflect proxy connection failure
        const message = `Could not connect to proxy server at "${this.proxyUrl}"`;
        this.log(`proxy.${ev.type}`, message); // Log as proxy error
        reject(new Error(message));
      };
      ws.addEventListener("error", onError);
      ws.addEventListener("open", (ev: Event) => {
        if (!this.config) {
          reject("Invalid config provided to 'connect(config)'");
          return;
        }
        this.log(`proxy.${ev.type}`, `connected to proxy socket`); // Log proxy connection
        this.emit("open");

        this.ws = ws;

        // Send the setup message THROUGH the proxy
        const setupMessage: SetupMessage = {
          setup: this.config,
        };
        this._sendDirect(setupMessage);
        this.log("client.send->proxy", "setup"); // Log direction

        ws.removeEventListener("error", onError);
        ws.addEventListener("close", (ev: CloseEvent) => {
          let reason = ev.reason || "";
          const wasClean = ev.wasClean;
          const code = ev.code;
          
          // Check for specific close codes from the proxy
          if (code === 1011) { // Example: Internal Server Error from proxy
              reason = `Proxy Error: ${reason}`;
              // Potentially show a user-facing error indicating a server problem
          }

          this.disconnect(ws);
          this.log(
            `proxy.${ev.type}`,
            `disconnected from proxy ${reason ? `with reason: ${reason}` : ``} (Code: ${code}, Clean: ${wasClean})`,
          );
          this.emit("close", ev);
        });
        resolve(true);
      });
    });
  }

  disconnect(ws?: WebSocket) {
    // could be that this is an old websocket and theres already a new instance
    // only close it if its still the correct reference
    if ((!ws || this.ws === ws) && this.ws) {
      // Send a disconnect message to the server before closing
      try {
        if (this.ws.readyState === WebSocket.OPEN) {
          this._sendDirect({ type: 'disconnect' });
          this.log("client.disconnect", "Sent disconnect message to server");
        }
      } catch (e) {
        console.error("Error sending disconnect message:", e);
      }
      
      this.ws.close(1000, "Client initiated disconnect");
      this.ws = null;
      this.log("client.close", `Disconnected from proxy`);
      return true;
    }
    return false;
  }

  protected async receive(blob: Blob) {
    const response: LiveIncomingMessage = (await blobToJSON(
      blob,
    )) as LiveIncomingMessage;
    if (isToolCallMessage(response)) {
      this.log("server.toolCall", response);
      this.emit("toolcall", response.toolCall);
      return;
    }
    if (isToolCallCancellationMessage(response)) {
      this.log("receive.toolCallCancellation", response);
      this.emit("toolcallcancellation", response.toolCallCancellation);
      return;
    }

    if (isSetupCompleteMessage(response)) {
      this.log("server.send", "setupComplete");
      this.emit("setupcomplete");
      return;
    }

    // Look for special message types
    try {
      // We need to cast the result to any since we're checking for message types
      // that aren't part of the standard LiveIncomingMessage type
      const responseObj: any = await blobToJSON(blob);
      
      if (isGoAwayMessage(responseObj)) {
        this.log("server.goAway", `timeLeft: ${responseObj.goAway.timeLeft}ms`);
        this.emit("goAway", responseObj.goAway.timeLeft);
        return;
      }
      
      if (isSessionResumptionUpdateMessage(responseObj)) {
        this.log("server.sessionUpdate", 
          `Handle: ${responseObj.sessionResumptionUpdate.newHandle}`);
        this.emit("sessionUpdate", responseObj.sessionResumptionUpdate.newHandle);
        return;
      }
    } catch (e) {
      // Ignore parsing errors and continue with normal message handling
    }

    // this json also might be `contentUpdate { interrupted: true }`
    // or contentUpdate { end_of_turn: true }
    if (isServerContentMessage(response)) {
      const { serverContent } = response;
      if (isInterrupted(serverContent)) {
        this.log("receive.serverContent", "interrupted");
        this.emit("interrupted");
        return;
      }
      if (isTurnComplete(serverContent)) {
        this.log("server.send", "turnComplete");
        this.emit("turncomplete");
        //plausible theres more to the message, continue
      }

      if (isModelTurn(serverContent)) {
        let parts: Part[] = serverContent.modelTurn.parts;

        // when its audio that is returned for modelTurn
        const audioParts = parts.filter(
          (p) => p.inlineData && p.inlineData.mimeType.startsWith("audio/pcm"),
        );
        const base64s = audioParts.map((p) => p.inlineData?.data);

        // strip the audio parts out of the modelTurn
        const otherParts = difference(parts, audioParts);
        // console.log("otherParts", otherParts);

        base64s.forEach((b64) => {
          if (b64) {
            const data = base64ToArrayBuffer(b64);
            this.emit("audio", data);
            this.log(`server.audio`, `buffer (${data.byteLength})`);
          }
        });
        if (!otherParts.length) {
          return;
        }

        parts = otherParts;

        const content: ModelTurn = { modelTurn: { parts } };
        this.emit("content", content);
        this.log(`server.content`, response);
      }
    } else {
      console.log("received unmatched message", response);
    }
  }

  /**
   * send realtimeInput, this is base64 chunks of "audio/pcm" and/or "image/jpg"
   */
  sendRealtimeInput(chunks: GenerativeContentBlob[]) {
    let hasAudio = false;
    let hasVideo = false;
    for (let i = 0; i < chunks.length; i++) {
      const ch = chunks[i];
      if (ch.mimeType.includes("audio")) {
        hasAudio = true;
      }
      if (ch.mimeType.includes("image")) {
        hasVideo = true;
      }
      if (hasAudio && hasVideo) {
        break;
      }
    }
    const message =
      hasAudio && hasVideo
        ? "audio + video"
        : hasAudio
          ? "audio"
          : hasVideo
            ? "video"
            : "unknown";

    const data: RealtimeInputMessage = {
      realtimeInput: {
        mediaChunks: chunks,
      },
    };
    this._sendDirect(data);
    this.log(`client.realtimeInput->proxy`, message);
  }

  /**
   *  send a response to a function call and provide the id of the functions you are responding to
   */
  sendToolResponse(toolResponse: ToolResponseMessage["toolResponse"]) {
    const message: ToolResponseMessage = {
      toolResponse,
    };

    this._sendDirect(message);
    this.log(`client.toolResponse->proxy`, message);
  }

  /**
   * send normal content parts such as { text }
   */
  send(parts: Part | Part[], turnComplete: boolean = true) {
    parts = Array.isArray(parts) ? parts : [parts];
    const content: Content = {
      role: "user",
      parts,
    };

    const clientContentRequest: ClientContentMessage = {
      clientContent: {
        turns: [content],
        turnComplete,
      },
    };

    this._sendDirect(clientContentRequest);
    this.log(`client.send->proxy`, clientContentRequest);
  }

  /**
   *  used internally to send all messages
   *  don't use directly unless trying to send an unsupported message type
   */
  _sendDirect(request: object) {
    if (!this.ws) {
      console.error("WebSocket (proxy) is not connected, cannot send message.");
      return; // Prevent sending if not connected
    }
    
    try {
      const str = JSON.stringify(request);
      this.ws.send(str);
    } catch (error) {
      console.error("Failed to stringify or send message:", error, request);
    }
  }
}
