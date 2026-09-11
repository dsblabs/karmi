import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";

// Recorded from the installed SDKs parsing the adjacent synthetic SSE fixtures.
export const recordings: { name: string; provider: string; parts: LanguageModelV4StreamPart[] }[] = [
  {
    name: "openai",
    provider: "openai.chat",
    parts: [
      {
        type: "stream-start",
        warnings: [],
      },
      {
        type: "raw",
        rawValue: {
          id: "chat-1",
          object: "chat.completion.chunk",
          created: 1,
          model: "test",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: "Hello",
              },
              finish_reason: null,
            },
          ],
        },
      },
      {
        type: "response-metadata",
        id: "chat-1",
        modelId: "test",
        timestamp: new Date("1970-01-01T00:00:01.000Z"),
      },
      {
        type: "text-start",
        id: "0",
      },
      {
        type: "text-delta",
        id: "0",
        delta: "Hello",
      },
      {
        type: "raw",
        rawValue: {
          id: "chat-1",
          object: "chat.completion.chunk",
          created: 1,
          model: "test",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 3,
            completion_tokens: 1,
            total_tokens: 4,
          },
        },
      },
      {
        type: "text-end",
        id: "0",
      },
      {
        type: "finish",
        finishReason: {
          unified: "stop",
          raw: "stop",
        },
        usage: {
          inputTokens: {
            total: 3,
            noCache: 3,
            cacheRead: 0,
            cacheWrite: undefined,
          },
          outputTokens: {
            total: 1,
            text: 1,
            reasoning: 0,
          },
          raw: {
            prompt_tokens: 3,
            completion_tokens: 1,
            total_tokens: 4,
          },
        },
        providerMetadata: {
          openai: {},
        },
      },
    ],
  },
  {
    name: "google",
    provider: "google.generative-ai",
    parts: [
      {
        type: "stream-start",
        warnings: [],
      },
      {
        type: "raw",
        rawValue: {
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  {
                    text: "Hello",
                  },
                ],
              },
              finishReason: "STOP",
              index: 0,
            },
          ],
          usageMetadata: {
            promptTokenCount: 3,
            candidatesTokenCount: 1,
            totalTokenCount: 4,
          },
          modelVersion: "test",
        },
      },
      {
        type: "text-start",
        id: "0",
      },
      {
        type: "text-delta",
        id: "0",
        delta: "Hello",
      },
      {
        type: "text-end",
        id: "0",
      },
      {
        type: "finish",
        finishReason: {
          unified: "stop",
          raw: "STOP",
        },
        usage: {
          inputTokens: {
            total: 3,
            noCache: 3,
            cacheRead: 0,
            cacheWrite: undefined,
          },
          outputTokens: {
            total: 1,
            text: 1,
            reasoning: 0,
          },
          raw: {
            promptTokenCount: 3,
            candidatesTokenCount: 1,
            totalTokenCount: 4,
          },
        },
        providerMetadata: {
          google: {
            promptFeedback: null,
            groundingMetadata: null,
            urlContextMetadata: null,
            safetyRatings: null,
            usageMetadata: {
              promptTokenCount: 3,
              candidatesTokenCount: 1,
              totalTokenCount: 4,
            },
            finishMessage: null,
            serviceTier: null,
          },
        },
      },
    ],
  },
  {
    name: "compatible",
    provider: "compatible.chat",
    parts: [
      {
        type: "stream-start",
        warnings: [],
      },
      {
        type: "raw",
        rawValue: {
          id: "chat-1",
          object: "chat.completion.chunk",
          created: 1,
          model: "test",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: "Hello",
              },
              finish_reason: null,
            },
          ],
        },
      },
      {
        type: "response-metadata",
        id: "chat-1",
        modelId: "test",
        timestamp: new Date("1970-01-01T00:00:01.000Z"),
      },
      {
        type: "text-start",
        id: "txt-0",
      },
      {
        type: "text-delta",
        id: "txt-0",
        delta: "Hello",
      },
      {
        type: "raw",
        rawValue: {
          id: "chat-1",
          object: "chat.completion.chunk",
          created: 1,
          model: "test",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 3,
            completion_tokens: 1,
            total_tokens: 4,
          },
        },
      },
      {
        type: "text-end",
        id: "txt-0",
      },
      {
        type: "finish",
        finishReason: {
          unified: "stop",
          raw: "stop",
        },
        usage: {
          inputTokens: {
            total: 3,
            noCache: 3,
            cacheRead: 0,
            cacheWrite: undefined,
          },
          outputTokens: {
            total: 1,
            text: 1,
            reasoning: 0,
          },
          raw: {
            prompt_tokens: 3,
            completion_tokens: 1,
            total_tokens: 4,
          },
        },
        providerMetadata: {
          compatible: {},
        },
      },
    ],
  },
  {
    name: "openrouter",
    provider: "openrouter",
    parts: [
      {
        type: "stream-start",
        warnings: [],
      },
      {
        type: "raw",
        rawValue: {
          id: "chat-1",
          object: "chat.completion.chunk",
          created: 1,
          model: "test",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: "Hello",
              },
              finish_reason: null,
            },
          ],
        },
      },
      {
        type: "response-metadata",
        id: "chat-1",
      },
      {
        type: "response-metadata",
        modelId: "test",
      },
      {
        type: "text-start",
        id: "chat-1",
      },
      {
        type: "text-delta",
        delta: "Hello",
        id: "chat-1",
      },
      {
        type: "raw",
        rawValue: {
          id: "chat-1",
          object: "chat.completion.chunk",
          created: 1,
          model: "test",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 3,
            completion_tokens: 1,
            total_tokens: 4,
            cost: 0.001,
            is_byok: true,
            cost_details: {
              upstream_inference_cost: 0.0008,
            },
          },
        },
      },
      {
        type: "response-metadata",
        id: "chat-1",
      },
      {
        type: "response-metadata",
        modelId: "test",
      },
      {
        type: "text-end",
        id: "chat-1",
      },
      {
        type: "finish",
        finishReason: {
          unified: "stop",
          raw: "stop",
        },
        usage: {
          inputTokens: {
            total: 3,
            noCache: 3,
            cacheRead: 0,
            cacheWrite: undefined,
          },
          outputTokens: {
            total: 1,
            text: 1,
            reasoning: 0,
          },
          raw: {
            prompt_tokens: 3,
            completion_tokens: 1,
            total_tokens: 4,
            cost: 0.001,
            cost_details: {
              upstream_inference_cost: 0.0008,
            },
            is_byok: true,
          },
        },
        providerMetadata: {
          openrouter: {
            usage: {
              promptTokens: 3,
              completionTokens: 1,
              cost: 0.001,
              totalTokens: 4,
              costDetails: {
                upstreamInferenceCost: 0.0008,
              },
            },
            reasoning_details: [],
          },
        },
      },
    ],
  },
  {
    name: "gateway",
    provider: "gateway",
    parts: [
      {
        type: "text-start",
        id: "1",
      },
      {
        type: "text-delta",
        id: "1",
        delta: "Hello",
      },
      {
        type: "text-end",
        id: "1",
      },
      {
        type: "finish",
        finishReason: {
          unified: "stop",
          raw: "stop",
        },
        usage: {
          inputTokens: {
            total: 3,
            noCache: 3,
            cacheRead: 0,
            cacheWrite: 0,
          },
          outputTokens: {
            total: 1,
            text: 1,
            reasoning: 0,
          },
        },
        providerMetadata: {
          gateway: {
            cost: "0.001",
            byok: true,
          },
        },
      },
    ],
  },
  {
    name: "workers-ai",
    provider: "workersai.chat",
    parts: [
      {
        type: "stream-start",
        warnings: [],
      },
      {
        type: "text-start",
        id: "OW5bdVSxYitk59G6",
      },
      {
        type: "text-delta",
        id: "OW5bdVSxYitk59G6",
        delta: "Hello",
      },
      {
        type: "text-end",
        id: "OW5bdVSxYitk59G6",
      },
      {
        finishReason: {
          unified: "stop",
          raw: "stop",
        },
        type: "finish",
        usage: {
          outputTokens: {
            total: 1,
            text: undefined,
            reasoning: undefined,
          },
          inputTokens: {
            total: 3,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          raw: {
            total: 4,
          },
        },
      },
    ],
  },
  {
    name: "cloudflare-gateway",
    provider: "openai.chat",
    parts: [
      {
        type: "stream-start",
        warnings: [],
      },
      {
        type: "raw",
        rawValue: {
          id: "chat-1",
          object: "chat.completion.chunk",
          created: 1,
          model: "test",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: "Hello",
              },
              finish_reason: null,
            },
          ],
        },
      },
      {
        type: "response-metadata",
        id: "chat-1",
        modelId: "test",
        timestamp: new Date("1970-01-01T00:00:01.000Z"),
      },
      {
        type: "text-start",
        id: "0",
      },
      {
        type: "text-delta",
        id: "0",
        delta: "Hello",
      },
      {
        type: "raw",
        rawValue: {
          id: "chat-1",
          object: "chat.completion.chunk",
          created: 1,
          model: "test",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 3,
            completion_tokens: 1,
            total_tokens: 4,
          },
        },
      },
      {
        type: "text-end",
        id: "0",
      },
      {
        type: "finish",
        finishReason: {
          unified: "stop",
          raw: "stop",
        },
        usage: {
          inputTokens: {
            total: 3,
            noCache: 3,
            cacheRead: 0,
            cacheWrite: undefined,
          },
          outputTokens: {
            total: 1,
            text: 1,
            reasoning: 0,
          },
          raw: {
            prompt_tokens: 3,
            completion_tokens: 1,
            total_tokens: 4,
          },
        },
        providerMetadata: {
          openai: {},
        },
      },
    ],
  },
];
