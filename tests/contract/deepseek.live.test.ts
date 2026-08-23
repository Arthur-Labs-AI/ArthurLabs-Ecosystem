import { test } from "node:test";
import assert from "node:assert/strict";

import { DeepSeekProvider } from "../../src/models/providers/deepseek";

/**
 * Optional live DeepSeek contract test (spec section 19.3).
 *
 * Disabled by default; runs only when DEEPSEEK_API_KEY is present. Never makes
 * the normal unit/integration suite depend on external API availability.
 */

const apiKey = process.env.DEEPSEEK_API_KEY;
const model = process.env.ARTHUR_MODEL_NAME || "deepseek-chat";

test(
  "DeepSeek live provider returns a valid normalized ModelResult",
  { skip: apiKey ? false : "DEEPSEEK_API_KEY not set; skipping live contract test" },
  async () => {
    const provider = new DeepSeekProvider({
      apiKey: apiKey as string,
      model,
      baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
      timeoutMs: 30000,
      retryMaxAttempts: 1,
      retryBaseDelayMs: 250,
      reasoningProfile: "normal",
    });

    const result = await provider.generate({
      systemContract: "You are a contract-test assistant.",
      modeContract: "",
      history: [],
      toolSchemas: [],
      userMessage: "Reply with exactly the word: pong",
      model,
      reasoningProfile: "normal",
    });

    assert.equal(typeof result.assistant_text, "string");
    assert.ok(result.assistant_text.length > 0);
    assert.ok(Array.isArray(result.tool_calls));
  },
);
