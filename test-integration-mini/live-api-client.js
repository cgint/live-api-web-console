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
  const USE_SCRIPT_PROCESSOR = true; // Force ScriptProcessor instead of AudioWorklet for compatibility
  
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
  
  function createWorketFromSrc(workletName, workletSrc) {
    const script = new Blob(
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
      for (let i = 0; i < l; i++) {      
      const int16Value = Math.max(-32768, Math.min(32767, float32Array[i] * 32768));
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
      this.scriptProcessor = null; // Added for compatibility
      this.vuWorklet = null;
      this.vuScriptProcessor = null; // Added for compatibility
      this._isStarting = false;
      this._startPromise = null;
      this.buffer = new Int16Array(AUDIO_BUFFER_SIZE);
      this.bufferWriteIndex = 0;
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
  
          // Try AudioWorklet first, then fall back to ScriptProcessor for compatibility
          if (!USE_SCRIPT_PROCESSOR && typeof AudioWorkletNode === 'function') {
            try {
              // Recording Worklet
              const recordingWorkletName = "audio-recorder-worklet";
              try {
                const processorCode = `registerProcessor("${recordingWorkletName}", ${AudioRecordingWorkletSrc})`;
                const blob = new Blob([processorCode], { type: "application/javascript" });
                const url = URL.createObjectURL(blob);
                await this.audioContext.audioWorklet.addModule(url);
                URL.revokeObjectURL(url);
                
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
                this.recordingWorklet.connect(this.audioContext.destination);
                console.log("Using AudioWorklet for recording");
              } catch (e) {
                console.error("Error adding recording worklet module:", e);
                throw e; // Force fallback to ScriptProcessor
              }
              
              // VU Meter Worklet
              const vuWorkletName = "vu-meter-in";
              try {
                const processorCode = `registerProcessor("${vuWorkletName}", ${VolMeterWorketSrc})`;
                const blob = new Blob([processorCode], { type: "application/javascript" });
                const url = URL.createObjectURL(blob);
                await this.audioContext.audioWorklet.addModule(url);
                URL.revokeObjectURL(url);
                
                this.vuWorklet = new AudioWorkletNode(this.audioContext, vuWorkletName);
                this.vuWorklet.port.onmessage = (ev) => this.emit("volume", ev.data.volume);
                this.source.connect(this.vuWorklet);
                this.vuWorklet.connect(this.audioContext.destination);
              } catch (e) {
                console.error("Error adding VU meter worklet module:", e);
                // Don't throw, VU meter is optional
              }
            } catch (e) {
              console.warn("AudioWorklet failed, falling back to ScriptProcessor:", e);
              this.setupScriptProcessorFallback();
            }
          } else {
            console.log("Using ScriptProcessor fallback for compatibility");
            this.setupScriptProcessorFallback();
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
  
    // Add a ScriptProcessor fallback method
    setupScriptProcessorFallback() {
      // Use ScriptProcessor for recording (older API but more compatible)
      const bufferSize = 4096;
      this.scriptProcessor = this.audioContext.createScriptProcessor(
        bufferSize,
        1, // input channels
        1  // output channels
      );
      
      this.scriptProcessor.onaudioprocess = (audioProcessingEvent) => {
        const inputBuffer = audioProcessingEvent.inputBuffer;
        const inputData = inputBuffer.getChannelData(0);
        
        // Convert float32 to int16 and fill buffer
        for (let i = 0; i < inputData.length; i++) {
          const int16Value = Math.max(-32768, Math.min(32767, inputData[i] * 32768));
          this.buffer[this.bufferWriteIndex++] = int16Value;
          
          if (this.bufferWriteIndex >= this.buffer.length) {
            // Send the filled buffer
            const base64 = arrayBufferToBase64(this.buffer.slice(0, this.bufferWriteIndex).buffer);
            this.emit("data", base64);
            this.bufferWriteIndex = 0;
          }
        }
      };
      
      // Create a simple VU meter
      this.vuScriptProcessor = this.audioContext.createScriptProcessor(2048, 1, 1);
      this.vuScriptProcessor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        let sum = 0;
        for (let i = 0; i < input.length; i++) {
          sum += input[i] * input[i];
        }
        const rms = Math.sqrt(sum / input.length);
        this.emit("volume", rms);
      };
      
      // Connect the graph
      this.source.connect(this.scriptProcessor);
      this.scriptProcessor.connect(this.audioContext.destination);
      
      this.source.connect(this.vuScriptProcessor);
      this.vuScriptProcessor.connect(this.audioContext.destination);
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
      if (this.scriptProcessor) {
        this.scriptProcessor.disconnect();
        this.scriptProcessor = null;
      }
      if (this.vuWorklet) {
        this.vuWorklet.disconnect();
        this.vuWorklet = null;
      }
      if (this.vuScriptProcessor) {
        this.vuScriptProcessor.disconnect();
        this.vuScriptProcessor = null;
      }
      // Reset buffer state
      this.bufferWriteIndex = 0;
      // Don't close context immediately, might be needed by streamer
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
      this.vuScriptProcessor = null; // Added for compatibility
    }
  
    async init() {
       if (!this.audioContext || this.audioContext.state === "suspended" || this.audioContext.state === "closed") {
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
          sampleRate: this.sampleRate,
        });
        await this.audioContext.resume();
        this.gainNode = this.audioContext.createGain();
        this.gainNode.connect(this.audioContext.destination);
  
        // Try AudioWorklet for VU meter, fall back to ScriptProcessor
        if (!USE_SCRIPT_PROCESSOR && typeof AudioWorkletNode === 'function') {
          // VU Meter Worklet (Output)
          const vuWorkletName = "vu-meter-out";
          try {
            const processorCode = `registerProcessor("${vuWorkletName}", ${VolMeterWorketSrc})`;
            const blob = new Blob([processorCode], { type: "application/javascript" });
            const url = URL.createObjectURL(blob);
            await this.audioContext.audioWorklet.addModule(url);
            URL.revokeObjectURL(url);
            
            this.vuWorklet = new AudioWorkletNode(this.audioContext, vuWorkletName);
            this.vuWorklet.port.onmessage = (ev) => this.emit("volume", ev.data.volume);
            this.gainNode.connect(this.vuWorklet);
            this.vuWorklet.connect(this.audioContext.destination);
            console.log("Using AudioWorklet for VU meter");
          } catch (e) {
            console.error("Error adding Output VU meter worklet module:", e);
            this.setupVuMeterScriptProcessor();
          }
        } else {
          console.log("Using ScriptProcessor for VU meter (compatibility mode)");
          this.setupVuMeterScriptProcessor();
        }
      } else {
          this.gainNode.connect(this.audioContext.destination); // Ensure connection
      }
    }
  
    // Add ScriptProcessor fallback for VU meter
    setupVuMeterScriptProcessor() {
      // Simple VU meter using ScriptProcessor
      try {
        this.vuScriptProcessor = this.audioContext.createScriptProcessor(2048, 1, 1);
        this.vuScriptProcessor.onaudioprocess = (event) => {
          const input = event.inputBuffer.getChannelData(0);
          let sum = 0;
          for (let i = 0; i < input.length; i++) {
            sum += input[i] * input[i];
          }
          const rms = Math.sqrt(sum / input.length);
          this.emit("volume", rms);
        };
        this.gainNode.connect(this.vuScriptProcessor);
        this.vuScriptProcessor.connect(this.audioContext.destination);
      } catch (e) {
        console.error("Error creating ScriptProcessor VU meter:", e);
        this.gainNode.connect(this.audioContext.destination); // Direct connection
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
       // Additional cleanup for ScriptProcessor
       if (this.vuScriptProcessor) {
         this.vuScriptProcessor.disconnect();
         this.vuScriptProcessor = null;
       }
       console.log("AudioStreamer stopped");
    }
  }
  
  // --- Live API Client ---
  class MultimodalLiveClient extends EventEmitter {
    constructor(apiKey) {
      super();
      if (!apiKey) {
        throw new Error("API Key is required for MultimodalLiveClient");
      }
      this.apiKey = apiKey;
      this.ws = null;
      this.config = null;
      this.connectionAttempt = 0;
      this.maxConnectionAttempts = 3;
      this.isConnecting = false;
      this.pendingAudioChunks = []; // Store audio chunks if connection isn't ready
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
        return Promise.resolve(true);
      }
      
      if (this.isConnecting) {
        console.log("Connection already in progress, waiting...");
        return new Promise((resolve, reject) => {
          const checkInterval = setInterval(() => {
            if (!this.isConnecting) {
              clearInterval(checkInterval);
              if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                resolve(true);
              } else {
                reject(new Error("Connection attempt failed while waiting"));
              }
            }
          }, 100);
        });
      }
      
      if (!config || !config.model) {
        throw new Error("Invalid config provided. 'model' is required.");
      }

      this.config = config;
      const targetUrl = `${GOOGLE_LIVE_API_BASE_URL}?key=${this.apiKey}`;
      this.log("client.connect", `Attempting to connect to ${targetUrl.split("?")[0]}...`);
      this.isConnecting = true;
      this.connectionAttempt++;

      return new Promise((resolve, reject) => {
        try {
          this.ws = new WebSocket(targetUrl);
        } catch (e) {
          this.log("client.error", `WebSocket creation failed: ${e.message}`);
          this.isConnecting = false;
          reject(e);
          return;
        }

        // Set timeout for initial connection
        const connectionTimeout = setTimeout(() => {
          if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
            this.log("client.error", "WebSocket connection timeout");
            this.ws.close(1000, "Connection timeout");
            this.isConnecting = false;
            reject(new Error("Connection timeout"));
          }
        }, 15000); // 15 second timeout

        const onOpen = (event) => {
          clearTimeout(connectionTimeout);
          this.log("client.open", "WebSocket connection established.");
          this.ws.removeEventListener("error", onError);

          // Send setup message
          const setupMessage = { setup: this.config };
          this._sendDirect(setupMessage);
          this.log("client.send->google", setupMessage);

          this.ws.addEventListener("message", this.handleMessage.bind(this));
          this.ws.addEventListener("close", this.handleClose.bind(this));
          this.ws.addEventListener("error", this.handleError.bind(this));

          this.isConnecting = false;
          this.connectionAttempt = 0; // Reset counter on success
          this.emit("open");
          
          // Process any pending audio chunks
          if (this.pendingAudioChunks.length > 0) {
            console.log(`Processing ${this.pendingAudioChunks.length} pending audio chunks`);
            this.sendRealtimeInput(this.pendingAudioChunks);
            this.pendingAudioChunks = [];
          }
          
          resolve(true);
        };

        const onError = (event) => {
          clearTimeout(connectionTimeout);
          const errorMsg = `WebSocket connection error to Google API. Check API Key and network.`;
          this.log("client.error", errorMsg);
          this.ws = null;
          this.isConnecting = false;
          this.emit("error", { message: errorMsg, event });
          reject(new Error(errorMsg));
        };

        const onClose = (event) => {
          clearTimeout(connectionTimeout);
          // This listener is primarily for the initial connection phase failure
          this.log("client.close", `WebSocket closed prematurely during connection. Code: ${event.code}, Reason: ${event.reason}`);
          this.ws = null;
          this.isConnecting = false;
          reject(new Error(`WebSocket connection failed. Code: ${event.code}`));
        };

        this.ws.addEventListener("open", onOpen, { once: true });
        this.ws.addEventListener("error", onError, { once: true });
        this.ws.addEventListener("close", onClose, { once: true });
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
      this.ws = null;
      
      // Emit close event
      this.emit("close", event);
      
      // Attempt reconnect for specific non-terminal close codes
      if (event.code === 1006 || event.code === 1001) {
        if (this.connectionAttempt < this.maxConnectionAttempts) {
          this.log("client.reconnect", `Attempting to reconnect (${this.connectionAttempt + 1}/${this.maxConnectionAttempts})...`);
          setTimeout(() => {
            this.connect(this.config).catch(err => {
              this.log("client.reconnect.error", `Reconnection failed: ${err.message}`);
            });
          }, 1000); // Wait 1 second before reconnecting
        }
      }
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
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        // Store chunks if not connected yet but connecting
        if (this.isConnecting) {
          this.pendingAudioChunks = this.pendingAudioChunks.concat(mediaChunks);
          this.log("client.queue", `Queued ${mediaChunks.length} audio chunk(s) while connecting`);
          return;
        }
        
        this.log("client.error", "WebSocket not open. Cannot send audio chunks.");
        return;
      }
      
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
    constructor(apiKeyInputId, startBtnId, stopBtnId, statusElId, options = {}) {
      this.apiKeyInput = document.getElementById(apiKeyInputId);
      this.startBtn = document.getElementById(startBtnId);
      this.stopBtn = document.getElementById(stopBtnId);
      this.statusEl = document.getElementById(statusElId);
      this.apiKey = "";
      this.client = null;
      this.recorder = null;
      this.streamer = null;
      this.isConnected = false;
      this.isStreaming = false; // Tracks if recorder is active
  
      // Extract options with defaults
      const {
        tools = [],
        toolHandlers = {},
        globalToolHandler = null,
        model = "models/gemini-2.0-flash-live-001",
        systemInstructionText = 'You are my helpful assistant.',
        initialMessageToAI = 'Hello. Pls start with "Hi, how can I help you today?"',
        generationConfig = {
          responseModalities: "audio",
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } },
          },
        }
      } = options;
  
      // Store tool definitions and handlers
      this.tools = tools;
      this.toolHandlers = toolHandlers;
      this.globalToolHandler = globalToolHandler;
      this.initialMessageToAI = initialMessageToAI;
  
      // Build config object for the API
      this.config = {
        model: model,
        generationConfig: generationConfig,
        systemInstruction: {
          parts: [{ text: systemInstructionText }],
        },
        tools: [
          // Format tool declarations properly
          { functionDeclarations: this.tools }
        ],
      };
  
      // Remove empty tools property if no tools defined
      if (!this.tools.length) {
        delete this.config.tools;
      }
  
      this._bindEvents();
    }
  
    _bindEvents() {
      this.startBtn.onclick = () => this.start();
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
      this.apiKeyInput.disabled = this.isConnected;
    }
  
    async start() {
      this.apiKey = this.apiKeyInput.value.trim();
      if (!this.apiKey) {
        this._updateStatus("API Key is required.", true);
        return;
      }
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
  
        // 3. Request microphone access BEFORE creating WebSocket connection
        this._updateStatus("Requesting microphone access...");
        this.recorder = new AudioRecorder();
        this._setupRecorderListeners();
        
        // Start recorder first to get mic permissions
        await this.recorder.start();
        this.isStreaming = true;
        
        // 4. Then connect WebSocket AFTER mic permission is granted
        this._updateStatus("Connecting to API...");
        await this.client.connect(this.config);
        this._updateStatus("Connected and streaming.");
        this._updateControls();

        // Send initial message to AI
        if (this.initialMessageToAI) {
          this.client.sendText(this.initialMessageToAI);
        }
  
      } catch (error) {
        this._updateStatus(`Failed to start: ${error.message}`, true);
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
      this._updateStatus("Stopped.");
    }
  
    _setupClientListeners() {
      this.client.on("log", (logEntry) => {
        // Optional: More detailed logging if needed
      });
  
      this.client.on("open", () => {
        this.isConnected = true;
        this._updateStatus("Connected and streaming.");
        this._updateControls();
      });
  
      this.client.on("close", (event) => {
        this.isConnected = false;
        if (this.isStreaming) {
          if (this.recorder) this.recorder.stop();
          this.isStreaming = false;
        }
        this._updateStatus(`Disconnected. Code: ${event.code}`, event.code !== 1000);
        this._updateControls();
        
        // Cleanup audio contexts
        if (this.recorder && this.recorder.audioContext && this.recorder.audioContext.state !== 'closed') {
          this.recorder.audioContext.close().catch(e => console.warn("Error closing recorder context:", e));
          this.recorder.audioContext = null;
        }
        if (this.streamer && this.streamer.audioContext && this.streamer.audioContext.state !== 'closed') {
          if (!this.recorder || this.streamer.audioContext !== this.recorder.audioContext) {
            this.streamer.audioContext.close().catch(e => console.warn("Error closing streamer context:", e));
          }
          this.streamer.audioContext = null;
        }
      });
  
      this.client.on("error", (error) => {
        console.error("WebSocket Error:", error);
        this._updateStatus(`Connection Error: ${error.message || error.type}`, true);
      });
  
      this.client.on("audio", (base64AudioData) => {
        if (this.streamer) {
          this.streamer.addPCM16Data(base64AudioData);
        }
      });
  
      this.client.on("content", (content) => {
        if (content.modelTurn && content.modelTurn.parts) {
          const textParts = content.modelTurn.parts.filter(p => p.text).map(p => p.text).join('');
          if(textParts) {
            console.log("Received Text:", textParts);
          }
        }
      });
  
      // Hybrid approach for tool call handling
      this.client.on("toolcall", async (toolCall) => {
        console.log("Received Tool Call:", toolCall);
        this._updateStatus("Tool call received...");
  
        try {
          // Process all function calls in the toolCall
          const responsePromises = toolCall.functionCalls.map(async (fc) => {
            let response;
  
            // Priority 1: Use specific tool handler if available
            if (this.toolHandlers[fc.name]) {
              try {
                // Pass both function call and client to the handler
                response = await this.toolHandlers[fc.name](fc, this.client);
              } catch (error) {
                console.error(`Error in handler for tool ${fc.name}:`, error);
                response = {
                  success: false,
                  message: `Error in tool handler: ${error.message}`
                };
              }
            } 
            // Priority 2: Use global handler if available
            else if (this.globalToolHandler) {
              try {
                response = await this.globalToolHandler(fc, this.client, toolCall);
              } catch (error) {
                console.error("Error in global tool handler:", error);
                response = {
                  success: false,
                  message: `Error in global tool handler: ${error.message}`
                };
              }
            } 
            // Priority 3: Default "not implemented" response
            else {
              console.warn(`No handler found for tool: ${fc.name}`);
              response = {
                success: false,
                message: "Tool not implemented client-side."
              };
            }
  
            return {
              id: fc.id,
              response: { output: response }
            };
          });
  
          // Wait for all responses to resolve
          const responses = await Promise.all(responsePromises);
          
          // Send responses back to the API
          if (responses.length > 0 && this.client && this.isConnected) {
            setTimeout(() => {
              if (this.client && this.isConnected) {
                this.client.sendToolResponse(responses);
                this._updateStatus("Sent tool response(s).");
              }
            }, 200);
          }
        } catch (error) {
          console.error("Error processing tool calls:", error);
          this._updateStatus(`Error processing tool calls: ${error.message}`, true);
        }
      });
  
      this.client.on("interrupted", () => {
        console.log("Model output interrupted (likely by user speech)");
        if (this.streamer) this.streamer.stop();
        this._updateStatus("Interrupted.");
      });
  
      this.client.on("turncomplete", () => {
        console.log("Model turn complete.");
      });
      
      this.client.on("setupcomplete", () => {
        console.log("Setup complete acknowledged by server.");
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
      });
      
      this.recorder.on("error", (error) => {
        console.error("Recorder Error:", error);
        this._updateStatus(`Recorder Error: ${error.message}`, true);
        this.stop();
      });
    }
  
    _setupStreamerListeners() {
      this.streamer.on("volume", (volume) => {
        // Optional: Display output volume meter
      });
      
      this.streamer.on("ended", () => {
        console.log("Audio playback finished.");
      });
      
      this.streamer.on("error", (error) => {
        console.error("Streamer Error:", error);
        this._updateStatus(`Streamer Error: ${error.message}`, true);
        this.streamer.stop();
      });
    }
  }
  
  // --- Define tools outside the controller ---
  const showAlertTool = {
    name: "show_alert",
    description: "Displays a message in a browser alert box.",
    parameters: {
      type: "OBJECT", 
      properties: {
        text: {
          type: "STRING",
          description: "The text message to display in the alert.",
        },
      },
      required: ["text"],
    },
  };
  
  // Define default handler for the alert tool
  const showAlertHandler = async function(fc, client) {
    console.log("Show Alert Tool Call Args:", fc.args);
    
    try {
      // Display the alert with the text from the tool call
      alert(`Message from Assistant:\n\n${fc.args.text}`);
      return {
        success: true, 
        message: "Alert displayed client-side."
      };
    } catch (e) {
      console.error("Error displaying alert:", e);
      return {
        success: false, 
        message: `Failed to display alert: ${e.message}`
      };
    }
  };
  
// --- Initialization ---
document.addEventListener("DOMContentLoaded", () => {
    // Get your API key from local storage or prompt user
    const storedApiKey = localStorage.getItem("geminiApiKey");
    const apiKeyInput = document.getElementById("apiKey");
    if (storedApiKey) {
        apiKeyInput.value = storedApiKey;
    }

    // Save API key when changed
    apiKeyInput.addEventListener('change', (e) => {
        localStorage.setItem("geminiApiKey", e.target.value);
    });

    // Example usage with both individual handlers and a global handler
    window.liveApiClient = new LiveApiClientController(
        "apiKey",
        "startBtn",
        "stopBtn",
        "status",
        {
            // Define tools
            tools: [showAlertTool],
            
            // Option 1: Individual handlers (per tool)
            toolHandlers: {
                "show_alert": showAlertHandler
            },
            
            // Option 2: Global handler (for all tools)
            // Uncomment to use this approach instead of or alongside individual handlers
            /*
            globalToolHandler: async (functionCall, client, toolCall) => {
                if (functionCall.name === "show_alert") {
                    return showAlertHandler(functionCall, client);
                }
                // Handle other tools as needed
                return { success: false, message: "Tool not implemented in global handler" };
            },
            */
            
            // Customize system instruction
            systemInstructionText: 'You are my helpful assistant.'
        }
    );
    
    console.log("Live API Client Controller initialized with custom tools.");
});