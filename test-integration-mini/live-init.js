
  
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