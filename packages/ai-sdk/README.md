# @karmi/ai-sdk

`@karmi/ai-sdk` is the karmi Provider for AI SDK model packages. With it, an Agent can use each model that has an AI SDK model package. Install the model packages that you use, for example `@ai-sdk/openai`.

Install the package:

```sh
pnpm add @karmi/core @karmi/ai-sdk
```

Read these pages of the karmi guide:

- [Providers](https://github.com/dsblabs/karmi/blob/main/docs/guide/05-providers.md) describes the Provider factory, the model packages and Cloudflare AI Gateway.
- [Credentials](https://github.com/dsblabs/karmi/blob/main/docs/guide/12-credentials.md) describes credential references.

By default, the Provider adds prompt-cache breakpoints for Anthropic models. Set `cache: false` in the options of `aiSdk` to remove them.

The AI SDK does not report the context window of a model. Thus Compaction uses 200,000 tokens, unless you give `capabilities` in the options of `aiSdk` or set `context.window` in the Agent Spec. The [Providers](https://github.com/dsblabs/karmi/blob/main/docs/guide/05-providers.md#options-of-the-ai-sdk-provider) page shows both options.
