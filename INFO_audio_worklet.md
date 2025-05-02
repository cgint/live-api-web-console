[Skip to main content](https://developer.chrome.com/blog/audio-worklet#main-content)[![Chrome for Developers](https://www.gstatic.com/devrel-devsite/prod/v8d1d0686aef3ca9671e026a6ce14af5c61b805aabef7c385b0e34494acbfc654/chrome/images/lockup.svg)](https://developer.chrome.com/)

[Get inspired](https://developer.chrome.com/case-studies)[Blog](https://developer.chrome.com/blog)[Docs](https://developer.chrome.com/docs)[New in Chrome](https://developer.chrome.com/new)

[ ]

/

Language[Sign in](https://developer.chrome.com/_d/signin?continue=https%3A%2F%2Fdeveloper.chrome.com%2Fblog%2Faudio-worklet&prompt=select_account)

* [Blog](https://developer.chrome.com/blog)
* **On this page**
* [Background: ScriptProcessorNode](https://developer.chrome.com/blog/audio-worklet#background_scriptprocessornode)
* [Concepts](https://developer.chrome.com/blog/audio-worklet#concepts)

  * [Registration and instantiation](https://developer.chrome.com/blog/audio-worklet#registration_and_instantiation)
  * [Custom audio parameters](https://developer.chrome.com/blog/audio-worklet#custom_audio_parameters)
  * [AudioWorkletProcessor.process() method](https://developer.chrome.com/blog/audio-worklet#audioworkletprocessorprocess_method)
  * [Bi-directional communication with MessagePort](https://developer.chrome.com/blog/audio-worklet#bi-directional_communication_with_messageport)
* [Walk through: Build a GainNode](https://developer.chrome.com/blog/audio-worklet#walk_through_build_a_gainnode)
* [Feature transition: Experimental to Stable](https://developer.chrome.com/blog/audio-worklet#feature_transition_experimental_to_stable)
* [Chrome for Developers](https://developer.chrome.com/)
* [Blog](https://developer.chrome.com/blog)

Was this helpful?

# Audio Worklet is now available by default**bookmark_border**

Hongchan Choi[](https://twitter.com/hochsays)[](https://hoch.io/)

**Note:** Audio Worklet is enabled by default in Chrome 66.Chrome 64 comes with a highly anticipated new feature in Web Audio API - [AudioWorklet](https://webaudio.github.io/web-audio-api/#AudioWorklet). Here you'll learn concepts and usage to create a custom audio processor with JavaScript code. Take a look at the [live demos](https://googlechromelabs.github.io/web-audio-samples/audio-worklet/). The next article in series, [Audio Worklet Design Pattern](https://developer.chrome.com/blog/audio-worklet-design-pattern), might be an interesting read for building an advanced audio app.

## Background: Script**Processor**Node

Audio processing in Web Audio API runs in a separate thread from the main UI thread, so it runs smoothly. To enable custom audio processing in JavaScript, the Web Audio API proposed a ScriptProcessorNode which used event handlers to invoke user script in the main UI thread.

There are two problems in this design: the event handling is asynchronous by design, and the code execution happens on the main thread. The former induces the latency, and the latter pressures the main thread that is commonly crowded with various UI and DOM-related tasks causing either UI to "jank" or audio to "glitch". Because of this fundamental design flaw, `ScriptProcessorNode` is deprecated from the specification and replaced with AudioWorklet.

## Concepts

Audio Worklet keeps the user-supplied JavaScript code all within the audio processing thread. That means it doesn't have to jump over to the main thread to process audio. This means the user-supplied script code gets to run on the audio rendering thread (`AudioWorkletGlobalScope`) along with other built-in `AudioNodes`, which ensures zero additional latency and synchronous rendering.

![Main global scope and Audio Worklet scope diagram](https://developer.chrome.com/static/blog/audio-worklet/image/main-global-scope-audio-1505a47d86d99.svg)
Fig.1

### Registration and instantiation

Using Audio Worklet consists of two parts: `AudioWorkletProcessor` and `AudioWorkletNode`. This is more involved than using ScriptProcessorNode, but it is needed to give developers the low-level capability for custom audio processing. `AudioWorkletProcessor` represents the actual audio processor written in JavaScript code, and it lives in the `AudioWorkletGlobalScope`. `AudioWorkletNode` is the counterpart of `AudioWorkletProcessor` and takes care of the connection to and from other `AudioNodes` in the main thread. It is exposed in the main global scope and functions like a regular `AudioNode`.

Here's a pair of code snippets that demonstrate the registration and the instantiation.

```
// The code in the main global scope.
classMyWorkletNodeextendsAudioWorkletNode{
constructor(context){
super(context,'my-worklet-processor');
}
}

letcontext=newAudioContext();

context.audioWorklet.addModule('processors.js').then(()=>{
letnode=newMyWorkletNode(context);
});
```

To create an `AudioWorkletNode`, you must add an AudioContext object and the processor name as a string. A processor definition can be loaded and registered by the new Audio Worklet object's `addModule()` call. Worklet APIs including Audio Worklet are only available in a [secure context](https://w3c.github.io/webappsec-secure-contexts/), thus a page using them must be served over HTTPS, although `http://localhost` is considered a secure for local testing.

You can subclass `AudioWorkletNode` to define a custom node backed by the processor running on the worklet.

```
// This is the "processors.js" file, evaluated in AudioWorkletGlobalScope
// upon audioWorklet.addModule() call in the main global scope.
classMyWorkletProcessorextendsAudioWorkletProcessor{
constructor(){
super();
}

process(inputs,outputs,parameters){
// audio processing code here.
}
}

registerProcessor('my-worklet-processor',MyWorkletProcessor);
```

The `registerProcessor()` method in the `AudioWorkletGlobalScope` takes a string for the name of processor to be registered and the class definition. After the completion of script code evaluation in the global scope, the promise from `AudioWorklet.addModule()` will be resolved notifying users that the class definition is ready to be used in the main global scope.

### Custom audio parameters

One of the useful things about AudioNodes is schedulable parameter automation with `AudioParam`. AudioWorkletNodes can use these to get exposed parameters that can be controlled at the audio rate automatically.

![Audio worklet node and processor diagram](https://developer.chrome.com/static/blog/audio-worklet/image/audio-worklet-node-proce-5cdb8f8650c7a.svg)
Fig.2

User-defined audio parameters can be declared in an `AudioWorkletProcessor` class definition by setting up a set of `AudioParamDescriptor`. The underlying WebAudio engine picks up this information during the construction of an AudioWorkletNode, and then creates and links `AudioParam` objects to the node accordingly.

```
/* A separate script file, like "my-worklet-processor.js" */
classMyWorkletProcessorextendsAudioWorkletProcessor{

// Static getter to define AudioParam objects in this custom processor.
staticgetparameterDescriptors(){
return[{
name:'myParam',
defaultValue:0.707
}];
}

constructor(){super();}

process(inputs,outputs,parameters){
// |myParamValues| is a Float32Array of either 1 or 128 audio samples
// calculated by WebAudio engine from regular AudioParam operations.
// (automation methods, setter) Without any AudioParam change, this array
// would be a single value of 0.707.
constmyParamValues=parameters.myParam;

if(myParamValues.length===1){
// |myParam| has been a constant value for the current render quantum,
// which can be accessed by |myParamValues[0]|.
}else{
// |myParam| has been changed and |myParamValues| has 128 values.
}
}
}
```

### `Audio<wbr/>Worklet<wbr/>Processor.<wbr/>process()` method

The actual audio processing happens in the `process()` callback method in the `AudioWorkletProcessor`. It must be implemented by a user in the class definition. The WebAudio engine invokes this function in an isochronous fashion to feed **inputs** and parameters and fetch  **outputs** .

```
/* AudioWorkletProcessor.process() method */
process(inputs,outputs,parameters){
// The processor may have multiple inputs and outputs. Get the first input and
// output.
constinput=inputs[0];
constoutput=outputs[0];

// Each input or output may have multiple channels. Get the first channel.
constinputChannel0=input[0];
constoutputChannel0=output[0];

// Get the parameter value array.
constmyParamValues=parameters.myParam;

// if |myParam| has been a constant value during this render quantum, the
// length of the array would be 1.
if(myParamValues.length===1){
// Simple gain (multiplication) processing over a render quantum
// (128 samples). This processor only supports the mono channel.
for(leti=0;i < inputChannel0.length;++i){
outputChannel0[i]=inputChannel0[i]*myParamValues[0];
}
}else{
for(leti=0;i < inputChannel0.length;++i){
outputChannel0[i]=inputChannel0[i]*myParamValues[i];
}
}

// To keep this processor alive.
returntrue;
}
```

Additionally, the return value of the `process()` method can be used to control the lifetime of `AudioWorkletNode` so that developers can manage the memory footprint. Returning `false` from `process()` method marks the processor inactive, and the `WebAudio` engine no longer invokes the method. To keep the processor alive, the method must return `true`. Otherwise, the node and processor pair is garbage collected by the system eventually.

### Bi-directional communication with MessagePort

Sometimes, a custom `AudioWorkletNode` wants to expose controls that don't map to `AudioParam`, such as a string-based `type` attribute used to control a custom filter. For this purpose and beyond, `AudioWorkletNode` and `AudioWorkletProcessor` are equipped with a `MessagePort` for bi-directional communication. Any kind of custom data can be exchanged through this channel.

![Fig.2](https://developer.chrome.com/static/blog/audio-worklet/image/fig2-e97ec1c7fd785.svg)
Fig.2

MessagePort can be accessed with the `.port` attribute on both the node and the processor. The node's `port.postMessage()` method sends a message to the associated processor's `port.onmessage` handler and in reverse.

```
/* The code in the main global scope. */
context.audioWorklet.addModule('processors.js').then(()=>{
letnode=newAudioWorkletNode(context,'port-processor');
node.port.onmessage=(event)=>{
// Handling data from the processor.
console.log(event.data);
};

node.port.postMessage('Hello!');
});
```

```
/* "processors.js" file. */
classPortProcessorextendsAudioWorkletProcessor{
constructor(){
super();
this.port.onmessage=(event)=>{
// Handling data from the node.
console.log(event.data);
};

this.port.postMessage('Hi!');
}

process(inputs,outputs,parameters){
// Do nothing, producing silent output.
returntrue;
}
}

registerProcessor('port-processor',PortProcessor);
```

`MessagePort` supports transferable, which lets you transfer data storage or a WASM module over the thread boundary. This opens up countless possibility on how the Audio Worklet system can be used.

## Walk through: Build a GainNode

Here's a complete example of GainNode built on top of `AudioWorkletNode` and `AudioWorkletProcessor`.

The `index.html` file:

```
<!doctype html>
<html>
<script>
  const context = new AudioContext();

  // Loads module script with AudioWorklet.
  context.audioWorklet.addModule('gain-processor.js').then(() => {
    let oscillator = new OscillatorNode(context);

    // After the resolution of module loading, an AudioWorkletNode can be
    // constructed.
    let gainWorkletNode = new AudioWorkletNode(context, 'gain-processor');

    // AudioWorkletNode can be interoperable with other native AudioNodes.
    oscillator.connect(gainWorkletNode).connect(context.destination);
    oscillator.start();
  });
</script>
</html>
```

The `gain-processor.js` file:

```
classGainProcessorextendsAudioWorkletProcessor{

// Custom AudioParams can be defined with this static getter.
staticgetparameterDescriptors(){
return[{name:'gain',defaultValue:1}];
}

constructor(){
// The super constructor call is required.
super();
}

process(inputs,outputs,parameters){
constinput=inputs[0];
constoutput=outputs[0];
constgain=parameters.gain;
for(letchannel=0;channel < input.length;++channel){
constinputChannel=input[channel];
constoutputChannel=output[channel];
if(gain.length===1){
for(leti=0;i < inputChannel.length;++i)
outputChannel[i]=inputChannel[i]*gain[0];
}else{
for(leti=0;i < inputChannel.length;++i)
outputChannel[i]=inputChannel[i]*gain[i];
}
}

returntrue;
}
}

registerProcessor('gain-processor',GainProcessor);
```

This covers the fundamental of Audio Worklet system. Live demos are available at [Chrome WebAudio team&#39;s GitHub repository](https://googlechromelabs.github.io/web-audio-samples/audio-worklet/).

## Feature transition: Experimental to Stable

Audio Worklet is enabled by default for Chrome 66 or later. In Chrome 64 and 65, the feature was behind the experimental flag.

Was this helpful?

Except as otherwise noted, the content of this page is licensed under the [Creative Commons Attribution 4.0 License](https://creativecommons.org/licenses/by/4.0/), and code samples are licensed under the [Apache 2.0 License](https://www.apache.org/licenses/LICENSE-2.0). For details, see the [Google Developers Site Policies](https://developers.google.com/site-policies). Java is a registered trademark of Oracle and/or its affiliates.

Last updated 2017-12-14 UTC.

* ### Contribute

  * [File a bug](https://issuetracker.google.com/issues/new?component=1400036&template=1897236)
  * [See open issues](https://issuetracker.google.com/issues?q=status:open%20componentid:1400036&s=created_time:desc)
* ### Related content

  * [Chromium updates](https://blog.chromium.org/)
  * [Case studies](https://developer.chrome.com/case-studies)
  * [Archive](https://developer.chrome.com/deprecated)
  * [Podcasts &amp; shows](https://web.dev/shows)
* ### Follow

  * [@ChromiumDev on X](https://twitter.com/ChromiumDev)
  * [YouTube](https://www.youtube.com/user/ChromeDevelopers)
  * [Chrome for Developers on LinkedIn](https://www.linkedin.com/showcase/chrome-for-developers)
  * [RSS](https://developer.chrome.com/static/blog/feed.xml)
* [Terms](https://policies.google.com/terms)
* [Privacy](https://policies.google.com/privacy)

Language
