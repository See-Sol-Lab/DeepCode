# Models and vision

English | [中文](models.zh.md)

DeepCode uses the Harness model and credential services directly. A model configured in **Settings → Models** is available to DeepCode without a second provider file or credential store.

## Configure DeepSeek

1. Open **Settings → Models**.
2. Select the DeepSeek provider.
3. Enter your DeepSeek API key.
4. Fetch or refresh the model list when the page offers that action.
5. Select the model you want to use for the session.

The provider may reject a key that is missing, invalid, expired, or not authorized for the selected model. DeepCode reports that failure without copying the key into its diagnostics.

## Use image input

Select a model whose input modalities include images, such as `deepseek-v4-flash-vision-exp` when it is available to your account. Attach an image to the message, add a clear instruction, and send it like an ordinary prompt.

An image-capable model can inspect screenshots, diagrams, UI states, and other visual inputs. A text-only model cannot infer an attachment's contents; switch models before asking it to reason about the image.

![A DeepCode vision session correctly describing an attached interface screenshot](assets/vision-response.png)

## Add a custom provider

Use the custom-provider form when you need an OpenAI-compatible endpoint or another provider exposed by the Harness settings page. Enter only the values required by that provider:

- Provider name and base URL.
- API key or credential, when required.
- Model id.
- Input capabilities, including image support when the endpoint accepts images.

Do not mark a text-only endpoint as image-capable. The selector uses this metadata to decide whether attachments can reach the model.

## Switch models

The active model belongs to the Harness session. Change it from the model selector in the conversation interface. Existing messages remain in the session; the next model receives the context that Harness prepares for the next turn.

## Troubleshooting

### The model list does not include the model I need

Refresh the provider's models. For a custom endpoint, add the exact model id supplied by the provider. Availability can differ by account and region.

### The session reports a missing credential

Return to **Settings → Models** and store the key for the same provider route the session uses. A key stored for one custom provider does not authorize another route.

### The model cannot see an attached image

Confirm that the selected model advertises image input and that the endpoint itself accepts OpenAI-compatible `image_url` content. Then start a small test message with one image and one direct question.

## Related guides

- [DeepCode quick start](quickstart.md)
- [Workspaces and sessions](workspaces-sessions.md)
- [Data and troubleshooting](data-troubleshooting.md)
- [Harness provider configuration](../guide/providers.md)
