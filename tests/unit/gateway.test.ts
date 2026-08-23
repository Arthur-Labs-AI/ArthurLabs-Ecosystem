import { test } from "node:test";
import assert from "node:assert/strict";

import { createModelProvider } from "../../src/app";
import { loadSettings } from "../../src/config/settings";
import { FakeProvider } from "../../src/models/providers/fake";
import { DeepSeekProvider } from "../../src/models/providers/deepseek";

test("provider selection picks FakeProvider for fake config", () => {
  const settings = loadSettings({ modelProvider: "fake", modelName: "fake-model" });
  const provider = createModelProvider(settings);
  assert.ok(provider instanceof FakeProvider);
  assert.equal(provider.id(), "fake");
});

test("provider selection picks DeepSeekProvider for deepseek config", () => {
  const settings = loadSettings({
    modelProvider: "deepseek",
    modelName: "deepseek-chat",
    deepseekApiKey: "sk-test",
  });
  const provider = createModelProvider(settings);
  assert.ok(provider instanceof DeepSeekProvider);
  assert.equal(provider.id(), "deepseek");
});
