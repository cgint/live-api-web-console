// --- Minimal EventEmitter ---
class EventEmitter {
    constructor() {
      this._events = {};
    }
  
    on(name, listener) {
      if (!this._events[name]) {
        this._events[name] = [];
      }
      this._events[name].push(listener);
      return this;
    }
  
    off(name, listenerToRemove) {
      if (!this._events[name]) return this;
      this._events[name] = this._events[name].filter(
        (listener) => listener !== listenerToRemove,    );
      return this;
    }
  
    emit(name, ...data) {
      if (!this._events[name]) return false;
      this._events[name].forEach((listener) => listener(...data));
      return true;
    }
  }
  
  // --- Constants ---
  const GOOGLE_LIVE_API_BASE_URL =
    "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
  const AUDIO_INPUT_SAMPLE_RATE = 16000;
  const AUDIO_OUTPUT_SAMPLE_RATE = 24000;
  const AUDIO_BUFFER_SIZE = 2048; // How often to send audio chunks
  
  // --- Helper Functions ---
  function arrayBufferToBase64(buffer) {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }
  
  function base64ToArrayBuffer(base64) {
    const binaryString = window.atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  }
  
  function blobToJSON(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const json = JSON.parse(reader.result);
          resolve(json);
        } catch (e) {
          reject(e);
        }
      };
      reader.onerror = reject;
      reader.readAsText(blob);
    });
  }
  
  function createWorketFromSrc(workletName, workletSrc) {  const script = new Blob(
      [`registerProcessor("${workletName}", ${workletSrc})`],
      { type: "application/javascript" },
    );
    return URL.createObjectURL(script);
  }
  
  // --- Worklet Code (Inlined) ---
  const AudioRecordingWorkletSrc = `
  class AudioProcessingWorklet extends AudioWorkletProcessor {
    buffer = new Int16Array(${AUDIO_BUFFER_SIZE});
    bufferWriteIndex = 0;
  
    process(inputs) {
      if (inputs[0] && inputs[0][0]) {
        const channel0 = inputs[0][0];
        this.processChunk(channel0);
      }
      return true;
    }
  
    sendAndClearBuffer(){
      this.port.postMessage({
        event: "chunk",
        data: {
          int16arrayBuffer: this.buffer.slice(0, this.bufferWriteIndex).buffer,
        },
      });
      this.bufferWriteIndex = 0;
    }
  
    processChunk(float32Array) {
      const l = float32Array.length;
      for (let i = 0; i < l; i++) {      const int16Value = Math.max(-32768, Math.min(32767, float32Array[i] * 32768));
        this.buffer[this.bufferWriteIndex++] = int16Value;
        if(this.bufferWriteIndex >= this.buffer.length) {
          this.sendAndClearBuffer();
        }
      }
    }
  }`;
  
  const VolMeterWorketSrc = `
  class VolMeter extends AudioWorkletProcessor {
    volume = 0;
    updateIntervalInMS = 50; // Update ~20 times/sec
    nextUpdateFrame = 0;
  
    constructor() {
      super();
      this.nextUpdateFrame = this.updateIntervalInMS;
    }
  
    get intervalInFrames() {
      return (this.updateIntervalInMS / 1000) * sampleRate;
    }
  
    process(inputs) {
      const input = inputs[0];
      if (input && input.length > 0 && input[0]) {
        const samples = input[0];
        let sum = 0;
        for (let i = 0; i < samples.length; ++i) {
          sum += samples[i] * samples[i];
        }
        const rms = Math.sqrt(sum / samples.length);
        this.volume = Math.max(rms, this.volume * 0.6); // Faster decay
  
        this.nextUpdateFrame -= samples.length;
        if (this.nextUpdateFrame <= 0) {
          this.nextUpdateFrame += this.intervalInFrames;
          this.port.postMessage({ volume: this.volume });
        }
      }
      return true;
    }}`;
  
  // --- Audio Classes ---
  class AudioRecorder extends EventEmitter {
    constructor(sampleRate = AUDIO_INPUT_SAMPLE_RATE) {
      super();
      this.sampleRate = sampleRate;
      this.stream = null;
      this.audioContext = null;
      this.source = null;
      this.recordingWorklet = null;
      this.vuWorklet = null;
      this._isStarting = false;
      this._startPromise = null;
    }
  
    async start() {
      if (this._isStarting || this.audioContext) return this._startPromise;
  
      this._isStarting = true;
      this._startPromise = new Promise(async (resolve, reject) => {
        try {
          if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            throw new Error("getUserMedia not supported");
          }
          this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  
          // Resume AudioContext if needed (important for browsers)
          if (!this.audioContext || this.audioContext.state === "suspended") {
            this.audioContext = new (window.AudioContext ||
              window.webkitAudioContext)({ sampleRate: this.sampleRate });
            await this.audioContext.resume();
          }
  
          this.source = this.audioContext.createMediaStreamSource(this.stream);
  
          // Recording Worklet
          const recordingWorkletName = "audio-recorder-worklet";
          try {
            await this.audioContext.audioWorklet.addModule(
              createWorketFromSrc(recordingWorkletName, AudioRecordingWorkletSrc),
            );
          } catch (e) {
            console.error("Error adding recording worklet module:", e);          throw e;
          }
          this.recordingWorklet = new AudioWorkletNode(
            this.audioContext,
            recordingWorkletName,
          );
          this.recordingWorklet.port.onmessage = (ev) => {
            if (ev.data.data.int16arrayBuffer) {
              const base64 = arrayBufferToBase64(ev.data.data.int16arrayBuffer);
              this.emit("data", base64);
            }
          };
          this.source.connect(this.recordingWorklet);
          this.recordingWorklet.connect(this.audioContext.destination); // Connect to output to keep graph alive
  
          // VU Meter Worklet
          const vuWorkletName = "vu-meter-in";
          try {
            await this.audioContext.audioWorklet.addModule(
              createWorketFromSrc(vuWorkletName, VolMeterWorketSrc),
            );
          } catch (e) {
            console.error("Error adding VU meter worklet module:", e);
            // Don't throw, VU meter is optional
          }
          if (this.audioContext.audioWorklet) {
              this.vuWorklet = new AudioWorkletNode(this.audioContext, vuWorkletName);
              this.vuWorklet.port.onmessage = (ev) => this.emit("volume", ev.data.volume);            this.source.connect(this.vuWorklet);
              this.vuWorklet.connect(this.audioContext.destination); // Keep alive
          }
  
  
          this._isStarting = false;
          console.log("AudioRecorder started");
          resolve();
        } catch (err) {
          console.error("Error starting AudioRecorder:", err);
          this.stop(); // Clean up on error
          this._isStarting = false;
          reject(err);
        }
      });
      return this._startPromise;
    }
  
    stop() {
      if (this._isStarting) {
          console.warn("AudioRecorder stopped while starting.");
          // Attempt cleanup even if start didn't fully complete
      }
      if (this.stream) {
        this.stream.getTracks().forEach((track) => track.stop());
        this.stream = null;
      }
      if (this.source) {
        this.source.disconnect();
        this.source = null;
      }
      if (this.recordingWorklet) {
        this.recordingWorklet.disconnect();
        this.recordingWorklet = null;
      }
       if (this.vuWorklet) {
        this.vuWorklet.disconnect();
        this.vuWorklet = null;
      }
      // Don't close context immediately, might be needed by streamer
      // if (this.audioContext && this.audioContext.state !== 'closed') {
      //     this.audioContext.close();
      //     this.audioContext = null;
      // }
      console.log("AudioRecorder stopped");
      this._startPromise = null; // Reset start promise
      this._isStarting = false;
    }
  }
  
  class AudioStreamer extends EventEmitter {
    constructor(sampleRate = AUDIO_OUTPUT_SAMPLE_RATE) {
      super();
      this.sampleRate = sampleRate;
      this.audioContext = null;
      this.gainNode = null;
      this.audioQueue = [];
      this.isPlaying = false;
      this.scheduledTime = 0;
      this.bufferSize = 7680; // Approx 320ms buffer at 24kHz
      this.processingBuffer = new Float32Array(0);
      this.checkInterval = null;
      this.initialBufferTime = 0.1; // 100ms initial buffer before playback
      this.endOfQueueAudioSource = null;
      this.vuWorklet = null;
    }
  
    async init() {
       if (!this.audioContext || this.audioContext.state === "suspended" || this.audioContext.state === "closed") {
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
          sampleRate: this.sampleRate,
        });
        await this.audioContext.resume();
        this.gainNode = this.audioContext.createGain();
        this.gainNode.connect(this.audioContext.destination);
  
        // VU Meter Worklet (Output)
          const vuWorkletName = "vu-meter-out";
          try {
            await this.audioContext.audioWorklet.addModule(
              createWorketFromSrc(vuWorkletName, VolMeterWorketSrc),
            );           this.vuWorklet = new AudioWorkletNode(this.audioContext, vuWorkletName);
             this.vuWorklet.port.onmessage = (ev) => this.emit("volume", ev.data.volume);
             this.gainNode.connect(this.vuWorklet); // Connect gain to VU meter
             this.vuWorklet.connect(this.audioContext.destination); // Connect VU meter to output
          } catch (e) {
            console.error("Error adding Output VU meter worklet module:", e);
             this.gainNode.connect(this.audioContext.destination); // Connect gain directly if VU fails
          }      console.log("AudioStreamer initialized and context resumed");
      } else {
          this.gainNode.connect(this.audioContext.destination); // Ensure connection
      }
    }
  
    addPCM16Data(base64Data) {
      if (!this.audioContext || this.audioContext.state !== 'running') {
          console.warn("AudioStreamer not ready or context not running, queuing data.");
          // Optionally queue data here if needed before init
          return;
      }
  
      const chunk = base64ToArrayBuffer(base64Data);
      const float32Array = new Float32Array(chunk.byteLength / 2);
      const dataView = new DataView(chunk);
  
      for (let i = 0; i < float32Array.length; i++) {
        const int16 = dataView.getInt16(i * 2, true); // Little-endian
        float32Array[i] = int16 / 32768; // Convert to [-1.0, 1.0]
      }    // Append to processing buffer
      const newBuffer = new Float32Array(
        this.processingBuffer.length + float32Array.length,
      );
      newBuffer.set(this.processingBuffer);
      newBuffer.set(float32Array, this.processingBuffer.length);
      this.processingBuffer = newBuffer;
  
      // Process chunks from the buffer
      while (this.processingBuffer.length >= this.bufferSize) {
        const buffer = this.processingBuffer.slice(0, this.bufferSize);
        this.audioQueue.push(buffer);
        this.processingBuffer = this.processingBuffer.slice(this.bufferSize);
      }
  
       if (!this.isPlaying && this.audioQueue.length > 0) {
          this.isPlaying = true;
          this.scheduledTime = this.audioContext.currentTime + this.initialBufferTime;
          this.scheduleNextBuffer();
       } else if (this.isPlaying) {
           // If already playing, ensure the scheduling loop is active
           this.scheduleNextBuffer();
       }
    }  scheduleNextBuffer() {
       if (!this.audioContext || this.audioContext.state !== 'running' || !this.isPlaying) return;
  
      const SCHEDULE_AHEAD_TIME = 0.2; // Schedule 200ms ahead
  
      while (
        this.audioQueue.length > 0 &&      this.scheduledTime < this.audioContext.currentTime + SCHEDULE_AHEAD_TIME
      ) {      const audioData = this.audioQueue.shift();
        const audioBuffer = this.audioContext.createBuffer(
          1, // num channels
          audioData.length,
          this.sampleRate,      );
        audioBuffer.getChannelData(0).set(audioData);
  
        const source = this.audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this.gainNode);
  
        // Track the last source node for end-of-stream detection
        if (this.endOfQueueAudioSource) {
          this.endOfQueueAudioSource.onended = null; // Clear previous handler
        }
         if (this.audioQueue.length === 0 && this.processingBuffer.length < this.bufferSize) {
              this.endOfQueueAudioSource = source;
              source.onended = () => {
                  // Check again upon ending in case more data arrived
                  if (this.audioQueue.length === 0 && this.processingBuffer.length < this.bufferSize && this.endOfQueueAudioSource === source) {
                     this.isPlaying = false;
                     this.endOfQueueAudioSource = null;
                     console.log("AudioStreamer finished playback.");
                     this.emit("ended");
                     if(this.checkInterval) {
                         clearInterval(this.checkInterval);
                         this.checkInterval = null;
                     }                }
              };
         }
  
  
        const startTime = Math.max(this.scheduledTime, this.audioContext.currentTime);
        source.start(startTime);
        this.scheduledTime = startTime + audioBuffer.duration;
      }
  
       // If queue is empty but still playing, set up a check interval
      if (this.isPlaying && this.audioQueue.length === 0 && !this.checkInterval) {
         this.checkInterval = setInterval(() => {
             if (this.audioQueue.length > 0 || this.processingBuffer.length >= this.bufferSize) {
                 this.scheduleNextBuffer();
             } else if (!this.isPlaying) { // Stop interval if playback ended
                 clearInterval(this.checkInterval);
                 this.checkInterval = null;           }
         }, 50); // Check every 50ms
      } else if (this.isPlaying && this.audioQueue.length > 0) {
          // If queue has items, schedule the next check precisely
          if (this.checkInterval) {
              clearInterval(this.checkInterval);
              this.checkInterval = null;
          }
          const timeUntilNextSchedule = (this.scheduledTime - this.audioContext.currentTime - SCHEDULE_AHEAD_TIME * 0.5) * 1000;
          setTimeout(() => this.scheduleNextBuffer(), Math.max(50, timeUntilNextSchedule));
      }
    }
  
    stop() {
      this.isPlaying = false;
      this.audioQueue = [];
      this.processingBuffer = new Float32Array(0);
      if (this.checkInterval) {
        clearInterval(this.checkInterval);
        this.checkInterval = null;
      }
       if (this.gainNode && this.audioContext && this.audioContext.state === 'running') {
          // Fade out smoothly
          this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, this.audioContext.currentTime);
          this.gainNode.gain.linearRampToValueAtTime(0, this.audioContext.currentTime + 0.1);
       }
       // Don't disconnect immediately, allow fade out
       // Consider closing context elsewhere if recorder/streamer share it
      console.log("AudioStreamer stopped");
    }
  }
  
  // --- Live API Client ---
  class MultimodalLiveClient extends EventEmitter {
    constructor(apiKey) {    super();
      if (!apiKey) {
        throw new Error("API Key is required for MultimodalLiveClient");
      }
      this.apiKey = apiKey;
      this.ws = null;
      this.config = null;
    }
  
    log(type, message) {
      const logEntry = {
        date: new Date(),
        type: type,
        message: message,
      };
      this.emit("log", logEntry);
      // Simple console log fallback
      // console.log(`[${logEntry.date.toLocaleTimeString()}] ${type}:`, typeof message === 'string' ? message : JSON.stringify(message).substring(0, 100) + '...');
    }
  
    async connect(config) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        console.warn("WebSocket already open. Disconnect first.");
        return;
      }
      if (!config || !config.model) {
          throw new Error("Invalid config provided. 'model' is required.");
      }
  
      this.config = config;
      const targetUrl = `${GOOGLE_LIVE_API_BASE_URL}?key=${this.apiKey}`;
      this.log("client.connect", `Attempting to connect to ${targetUrl.split("?")[0]}...`);
  
      return new Promise((resolve, reject) => {
        try {
          this.ws = new WebSocket(targetUrl);
        } catch (e) {
          this.log("client.error", `WebSocket creation failed: ${e.message}`);
          reject(e);
          return;
        }      const onOpen = (event) => {
          this.log("client.open", "WebSocket connection established.");
          this.ws.removeEventListener("error", onError); // Remove temporary error handler
  
          // Send setup message        const setupMessage = { setup: this.config };
          this._sendDirect(setupMessage);
          this.log("client.send->google", setupMessage);
  
          this.ws.addEventListener("message", this.handleMessage.bind(this));
          this.ws.addEventListener("close", this.handleClose.bind(this));        this.ws.addEventListener("error", this.handleError.bind(this)); // Add persistent error handler
  
          this.emit("open");
          resolve(true);
        };
  
        const onError = (event) => {        const errorMsg = `WebSocket connection error to Google API. Check API Key and network.`;
          this.log("client.error", errorMsg);
          this.ws = null; // Ensure ws is null on connection failure
          this.emit("error", { message: errorMsg, event });
          reject(new Error(errorMsg));
        };
  
        const onClose = (event) => {
            // This listener is primarily for the initial connection phase failure
            this.log("client.close", `WebSocket closed prematurely during connection. Code: ${event.code}, Reason: ${event.reason}`);
            this.ws = null;
            reject(new Error(`WebSocket connection failed. Code: ${event.code}`));
        };
  
        this.ws.addEventListener("open", onOpen, { once: true });
        this.ws.addEventListener("error", onError, { once: true });
        this.ws.addEventListener("close", onClose, { once: true }); // Handle unexpected close during connect
      });
    }
  
    disconnect() {
      if (this.ws) {
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
          this.ws.close(1000, "Client initiated disconnect");
          this.log("client.disconnect", "WebSocket connection closed by client.");
        }
        // handleClose event listener will manage cleanup and emitting 'close'
        this.ws = null; // Set to null immediately
      } else {
          this.log("client.disconnect", "No active WebSocket connection to disconnect.");
      }
    }
  
    handleMessage = async (event) => {
      if (event.data instanceof Blob) {
        try {
          const message = await blobToJSON(event.data);
          this.log("google.receive", message); // Log parsed message
  
          if (message.toolCall) {
            this.emit("toolcall", message.toolCall);
          } else if (message.toolCallCancellation) {
            this.emit("toolcallcancellation", message.toolCallCancellation);
          } else if (message.setupComplete) {
            this.emit("setupcomplete");
          } else if (message.goAway) {          this.emit("goAway", message.goAway.timeLeft);
          } else if (message.sessionResumptionUpdate) {
            this.emit("sessionUpdate", message.sessionResumptionUpdate.newHandle);
          } else if (message.serverContent) {
            const content = message.serverContent;
            if (content.interrupted) {
              this.emit("interrupted");
            } else if (content.turnComplete) {
              this.emit("turncomplete");
            }
            if (content.modelTurn) {
               let hasAudio = false;
               content.modelTurn.parts.forEach(part => {                if (part.inlineData && part.inlineData.mimeType?.startsWith('audio/')) {
                      hasAudio = true;
                      this.emit('audio', part.inlineData.data); // Emit base64 audio data
                  }
               });
               // Emit content only if there are non-audio parts or no audio at all
               const nonAudioParts = content.modelTurn.parts.filter(p => !p.inlineData || !p.inlineData.mimeType?.startsWith('audio/'));
               if (nonAudioParts.length > 0 || !hasAudio) {
                   this.emit("content", { modelTurn: { parts: nonAudioParts } });
               }
            }
          } else if (message.usageMetadata) {
              this.emit("usage", message.usageMetadata);
          } else {
             console.warn("Received unhandled message structure:", message);
          }
  
        } catch (error) {
          this.log("client.error", `Error parsing message blob: ${error}`);
          console.error("Failed to parse message blob:", error);
        }
      } else {
        this.log("google.receive", `Received non-blob data: ${typeof event.data}`);
      }
    };
  
    handleClose = (event) => {
      this.log(
        "client.close",
        `WebSocket closed. Code: ${event.code}, Reason: "${event.reason}", Clean: ${event.wasClean}`,
      );
      this.ws = null; // Ensure ws is null
      this.emit("close", event);
    };
  
    handleError = (event) => {
      this.log("client.error", `WebSocket error: ${event.type}`);
      this.emit("error", event);
      // The 'close' event will usually follow an error.
    };
  
    _sendDirect(request) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.log("client.error", "WebSocket not open. Cannot send message.");
        console.error("WebSocket not open. Cannot send message:", request);
        return;
      }
      try {
        const str = JSON.stringify(request);      this.ws.send(str);
      } catch (error) {
        this.log("client.error", `Failed to stringify/send message: ${error}`);
        console.error("Failed to stringify or send message:", error, request);
      }
    }
  
    // --- Public Send Methods ---
    sendRealtimeInput(mediaChunks) {
      const message = { realtimeInput: { mediaChunks } };
      this._sendDirect(message);
      this.log("client.send->google", { type: "realtimeInput", chunks: mediaChunks.length });
    }
  
    sendToolResponse(functionResponses) {
      const message = { toolResponse: { functionResponses } };
      this._sendDirect(message);
      this.log("client.send->google", message);
    }
  
    sendText(text, turnComplete = true) {
      const message = {
        clientContent: {
          turns: [{ role: "user", parts: [{ text }] }],
          turnComplete,
        },
      };
      this._sendDirect(message);
      this.log("client.send->google", message);
    }
  }
  
  // --- Main Controller ---
  class LiveApiClientController {
    constructor(apiKeyInputId, startBtnId, stopBtnId, statusElId) {    this.apiKeyInput = document.getElementById(apiKeyInputId);
      this.startBtn = document.getElementById(startBtnId);
      this.stopBtn = document.getElementById(stopBtnId);
      this.statusEl = document.getElementById(statusElId);
  
      this.apiKey = "";
      this.client = null;
      this.recorder = null;
      this.streamer = null;
      this.isConnected = false;
      this.isStreaming = false; // Tracks if recorder is active
  
      // Tool definition (from Altair example)
      this.renderAltairTool = {
          name: "render_altair",
          description: "Displays an altair graph in json format.",
          parameters: {
              type: "OBJECT", // Note: Use string values for SchemaType enums in plain JS
              properties: {
              json_graph: {
                  type: "STRING",
                  description: "JSON STRING representation of the graph to render. Must be a string, not a json object",
              },
              },
              required: ["json_graph"],
          },
      };
  
      this.config = {
          model: "models/gemini-1.5-flash-latest", // Or "models/gemini-1.5-pro-latest" etc.
          generationConfig: {
              responseModalities: "audio", // Request audio output
              speechConfig: {
                  voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } },
              },
          },
          systemInstruction: {
              parts: [{ text: 'You are my helpful assistant. Any time I ask you for a graph call the "render_altair" function I have provided you. Dont ask for additional information just make your best judgement.' }],
          },
          tools: [
              // { googleSearch: {} }, // Optional: requires billing enabled
              { functionDeclarations: [this.renderAltairTool] }
          ],
      };
  
      this._bindEvents();
    }
  
    _bindEvents() {    this.startBtn.onclick = () => this.start();
      this.stopBtn.onclick = () => this.stop();
    }
  
    _updateStatus(message, isError = false) {
      console.log(`Status: ${message}` + (isError ? " (Error)" : ""));
      this.statusEl.textContent = message;
      this.statusEl.style.color = isError ? "red" : "inherit";
    }
  
    _updateControls() {
      this.startBtn.disabled = this.isConnected;
      this.stopBtn.disabled = !this.isConnected;
      this.apiKeyInput.disabled = this.isConnected;  }
  
    async start() {
      this.apiKey = this.apiKeyInput.value.trim();
      if (!this.apiKey) {
        this._updateStatus("API Key is required.", true);
        return;    }
      this._updateStatus("Starting...");
      this.startBtn.disabled = true; // Disable start button immediately
  
      try {
        // 1. Initialize Client
        this.client = new MultimodalLiveClient(this.apiKey);
        this._setupClientListeners();
  
        // 2. Initialize Audio Streamer (for output)
        this.streamer = new AudioStreamer();
        await this.streamer.init(); // Initialize and resume context
        this._setupStreamerListeners();
  
        // 3. Initialize Audio Recorder (for input)
        this.recorder = new AudioRecorder();
        this._setupRecorderListeners();
        // Start recorder *after* successful connection attempt
  
        // 4. Connect WebSocket
        await this.client.connect(this.config);
        // Connection successful listener (onOpen) will handle state update
  
        // 5. Start recorder *now* after successful connection
        await this.recorder.start();
        this.isStreaming = true;
  
  
      } catch (error) {      this._updateStatus(`Failed to start: ${error.message}`, true);
        this.stop(); // Ensure cleanup on failure
      }
    }
  
    stop() {
      this._updateStatus("Stopping...");
      if (this.recorder && this.isStreaming) {
        this.recorder.stop();
        this.isStreaming = false;
      }
      if (this.streamer) {
        this.streamer.stop();
      }
      if (this.client) {
        this.client.disconnect();
      }
      // Client's onClose handler will set isConnected = false and update controls
      // Resetting state here can cause race conditions if close event hasn't fired
      // this.isConnected = false;
      // this._updateControls();    this._updateStatus("Stopped.");
    }
  
    _setupClientListeners() {
      this.client.on("log", (logEntry) => {
        // Optional: More detailed logging if needed
        // console.log(`[LOG] ${logEntry.type}:`, logEntry.message);
      });
  
      this.client.on("open", () => {
        this.isConnected = true;
        this._updateStatus("Connected and streaming.");
        this._updateControls();
        // Recorder start is now handled in the start() method after connect succeeds
      });    this.client.on("close", (event) => {
        this.isConnected = false;
         if (this.isStreaming) { // Stop recorder if it was running
              if (this.recorder) this.recorder.stop();            this.isStreaming = false;
          }
        this._updateStatus(`Disconnected. Code: ${event.code}`, event.code !== 1000);
        this._updateControls();
         // Attempt cleanup of audio contexts if they exist
         if (this.recorder && this.recorder.audioContext && this.recorder.audioContext.state !== 'closed') {
             this.recorder.audioContext.close().catch(e => console.warn("Error closing recorder context:", e));
             this.recorder.audioContext = null;
         }
         if (this.streamer && this.streamer.audioContext && this.streamer.audioContext.state !== 'closed') {
             // Check if it's the same context as the recorder
             if (!this.recorder || this.streamer.audioContext !== this.recorder.audioContext) {
                 this.streamer.audioContext.close().catch(e => console.warn("Error closing streamer context:", e));
             }
             this.streamer.audioContext = null;
         }
      });
  
      this.client.on("error", (error) => {
        console.error("WebSocket Error:", error);
        // Status might be updated by 'close' event as well
        this._updateStatus(`Connection Error: ${error.message || error.type}`, true);
        // No need to call stop() here, 'close' event handles cleanup
      });
  
      this.client.on("audio", (base64AudioData) => {
        if (this.streamer) {
          this.streamer.addPCM16Data(base64AudioData);
        }
      });    this.client.on("content", (content) => {
        // Handle text content from the model if needed
        if (content.modelTurn && content.modelTurn.parts) {
          const textParts = content.modelTurn.parts.filter(p => p.text).map(p => p.text).join('');
          if(textParts) {
              console.log("Received Text:", textParts);
              // You could display this text somewhere in the UI
              // this._updateStatus(`Received: ${textParts.substring(0, 50)}...`);
          }
        }
      });
  
      this.client.on("toolcall", (toolCall) => {
          console.log("Received Tool Call:", toolCall);
          this._updateStatus("Tool call received...");
  
          const altairCall = toolCall.functionCalls.find(fc => fc.name === this.renderAltairTool.name);
  
          if (altairCall) {
              console.log("Altair Tool Call Args:", altairCall.args);
              // TODO: Process the altairCall.args.json_graph if needed            // For now, just send a success response immediately
  
              const response = {
                  functionResponses: [{                    id: altairCall.id,
                      response: { output: { success: true, message: "Graph processed client-side." } } // Simple success object
                  }]
              };
              setTimeout(() => { // Add slight delay
                  this.client.sendToolResponse(response.functionResponses);
                  this._updateStatus("Sent tool response.");
              }, 200);
          } else {
              // Handle other potential tool calls or send generic responses if needed
              const responses = toolCall.functionCalls.map(fc => ({
                   id: fc.id,
                   response: { output: { success: false, message: "Tool not implemented client-side." } }
              }));
               if(responses.length > 0) {
                  setTimeout(() => {
                      this.client.sendToolResponse(responses);
                      this._updateStatus("Sent default tool response(s).");                }, 200);
              }
          }
      });
  
       this.client.on("interrupted", () => {
          console.log("Model output interrupted (likely by user speech)");
          if (this.streamer) this.streamer.stop(); // Stop playback immediately
          this._updateStatus("Interrupted.");
       });
  
       this.client.on("turncomplete", () => {
           console.log("Model turn complete.");         // Maybe update status briefly
       });
       this.client.on("setupcomplete", () => {         console.log("Setup complete acknowledged by server.");
       });
    }
  
    _setupRecorderListeners() {
      this.recorder.on("data", (base64AudioData) => {
        if (this.client && this.isConnected) {
          this.client.sendRealtimeInput([{ mimeType: "audio/pcm", data: base64AudioData }]);
        }
      });
      this.recorder.on("volume", (volume) => {
        // Optional: Display input volume meter
        // console.log("Input Volume:", volume.toFixed(3));
      });
      this.recorder.on("error", (error) => {
         console.error("Recorder Error:", error);
         this._updateStatus(`Recorder Error: ${error.message}`, true);
         // May need to attempt restart or stop completely
         this.stop();
      });
    }
  
     _setupStreamerListeners() {
      this.streamer.on("volume", (volume) => {
          // Optional: Display output volume meter
          // console.log("Output Volume:", volume.toFixed(3));    });
      this.streamer.on("ended", () => {
          console.log("Audio playback finished.");
          // Optional: Update status or UI
      });
       this.streamer.on("error", (error) => { // Add error handling for streamer
         console.error("Streamer Error:", error);
         this._updateStatus(`Streamer Error: ${error.message}`, true);
         // May need to stop playback
         this.streamer.stop();
      });
    }
  
  }
  
  // --- Initialization ---
  // Wait for the DOM to be ready
  document.addEventListener("DOMContentLoaded", () => {
    // Get your API key from local storage or prompt user (more secure than hardcoding)
    const storedApiKey = localStorage.getItem("geminiApiKey");
    const apiKeyInput = document.getElementById("apiKey");
    if (storedApiKey) {
        apiKeyInput.value = storedApiKey;
    }
  
    // Save API key when changed
    apiKeyInput.addEventListener('change', (e) => {      localStorage.setItem("geminiApiKey", e.target.value);
    });
  
  
    // Instantiate the controller
    window.liveApiClient = new LiveApiClientController(
      "apiKey",
      "startBtn",
      "stopBtn",
      "status",
    );
    console.log("Live API Client Controller initialized.");
});