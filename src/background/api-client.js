/**
 * LM Studio API Client - YouTube Auto Reply Extension
 * 
 * This module provides a simple client for sending chat completion requests
 * to the local LM Studio server.
 */

import { getSettings } from '../core/storage.js';

// Default timeout in milliseconds (30 seconds)
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Send a chat completion request to LM Studio.
 * 
 * @param {Array<Object>} messages - Array of message objects with role and content
 * @param {Object} options - Optional override for specific settings (temperature, maxTokens)
 * @returns {Promise<Object>} Object with the following shape:
 *   - `text`: The assistant's reply (from `content` field, or fallback to `reasoning_content` if empty)
 *   - `reasoning`: The model's internal thinking (from `reasoning_content`, may be empty string)
 *   - `raw`: The original response payload for debugging
 * @throws {Error} If the request fails or response is invalid
 */
async function chatCompletion(messages, options = {}) {
  let abortController;
  let timeoutId;

  try {
    // Read current settings from storage
    const settings = await getSettings();

    // Get LM Studio configuration with optional overrides
    const lmStudioConfig = { ...settings.lmStudio };

    // Apply optional overrides if provided
    if (options.temperature !== undefined) {
      lmStudioConfig.temperature = options.temperature;
    }
    if (options.maxTokens !== undefined) {
      lmStudioConfig.maxTokens = options.maxTokens;
    }

    // Build the API URL
    const apiUrl = `${lmStudioConfig.baseUrl}/chat/completions`;

    // Prepare request headers with Bearer token authentication
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${lmStudioConfig.apiKey}`
    };

    // Build the request body
    const requestBody = {
      model: lmStudioConfig.model,
      messages,
      temperature: lmStudioConfig.temperature,
      max_tokens: lmStudioConfig.maxTokens
    };

    // Remove undefined values from request body
    Object.keys(requestBody).forEach(key => {
      if (requestBody[key] === undefined) {
        delete requestBody[key];
      }
    });

    // Create AbortController for timeout handling
    abortController = new AbortController();

    // Set up the timeout
    timeoutId = setTimeout(() => {
      abortController.abort();
    }, DEFAULT_TIMEOUT_MS);

    // Send POST request to LM Studio API with abort signal
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal: abortController.signal
    });

    // Check for HTTP errors (excluding timeout which is handled by AbortSignal)
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LM Studio request failed: ${response.status} - ${errorText}`);
    }

    // Parse JSON response
    let responseData;
    try {
      responseData = await response.json();
    } catch (parseError) {
      const errorText = await response.text();
      throw new Error(`LM Studio returned invalid JSON: ${errorText}`);
    }

    // Validate response shape - expect OpenAI-compatible format with choices array
    if (!responseData.choices || !Array.isArray(responseData.choices) || responseData.choices.length === 0) {
      throw new Error('LM Studio returned an invalid response (no choices)');
    }

    // Extract the assistant's message from the OpenAI-compatible response shape
    const assistantMessage = responseData.choices[0].message;

    // The model returns both 'content' (actual reply) and 'reasoning_content' (internal thinking).
    // For a clean user-facing text, prefer 'content', but fall back to 'reasoning_content'
    // when content is empty or whitespace. This handles reasoning models that spend their token
    // budget on thinking first.
    const rawContent = assistantMessage.content;
    const reasoningContent = assistantMessage.reasoning_content || '';

    // Extract text: prefer content, fall back to reasoning_content if content is empty/whitespace
    let text;
    if (rawContent && typeof rawContent === 'string' && rawContent.trim() !== '') {
      text = rawContent;  // Actual reply found in content field
    } else {
      text = reasoningContent;  // Fallback to reasoning_content when content is empty
    }

    // Return the result with extracted text, reasoning (if any), and raw response for debugging
    return {
      text,
      reasoning: reasoningContent,
      raw: responseData
    };

  } catch (error) {
    // Check if the error was caused by timeout
    if (error.name === 'AbortError') {
      console.error('[YouTube Auto Reply] LM Studio request timed out after', DEFAULT_TIMEOUT_MS, 'ms');
      throw new Error(`LM Studio request timed out after ${DEFAULT_TIMEOUT_MS / 1000} seconds`);
    }

    // Log and re-throw other errors
    console.error('[YouTube Auto Reply] LM Studio API error:', error.message);
    throw error;
  } finally {
    // Clean up the timeout timer if it's still running
    if (abortController && timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * Get available models from LM Studio.
 * 
 * @returns {Promise<Array<Object>>} Array of model objects with id and object type
 * @throws {Error} If the request fails or response is invalid
 */
async function getModels() {
  let abortController;
  let timeoutId;

  try {
    // Read current settings from storage
    const settings = await getSettings();

    // Build the API URL for models endpoint
    const apiUrl = `${settings.lmStudio.baseUrl}/models`;

    // Prepare request headers with Bearer token authentication
    const headers = {
      'Authorization': `Bearer ${settings.lmStudio.apiKey}`
    };

    // Create AbortController for timeout handling
    abortController = new AbortController();

    // Set up the timeout (reuse existing 30-second timeout)
    timeoutId = setTimeout(() => {
      abortController.abort();
    }, DEFAULT_TIMEOUT_MS);

    // Send GET request to LM Studio models endpoint with abort signal
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers,
      signal: abortController.signal
    });

    // Check for HTTP errors (excluding timeout which is handled by AbortSignal)
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LM Studio request failed: ${response.status} - ${errorText}`);
    }

    // Parse JSON response
    let responseData;
    try {
      responseData = await response.json();
    } catch (parseError) {
      const errorText = await response.text();
      throw new Error(`LM Studio returned invalid JSON: ${errorText}`);
    }

    // Validate response shape - expect OpenAI-compatible format with data array
    if (!responseData.data || !Array.isArray(responseData.data)) {
      throw new Error('LM Studio returned an invalid models response');
    }

    // Return the model list as an array
    return responseData.data;

  } catch (error) {
    // Check if the error was caused by timeout
    if (error.name === 'AbortError') {
      console.error('[YouTube Auto Reply] LM Studio request timed out after', DEFAULT_TIMEOUT_MS, 'ms');
      throw new Error(`LM Studio request timed out after ${DEFAULT_TIMEOUT_MS / 1000} seconds`);
    }

    // Log and re-throw other errors
    console.error('[YouTube Auto Reply] LM Studio API error:', error.message);
    throw error;
  } finally {
    // Clean up the timeout timer if it's still running
    if (abortController && timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export { chatCompletion, getModels };