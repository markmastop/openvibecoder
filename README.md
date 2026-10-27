# Open Vibe Coder

**Version 0.3.0** — an English-language local vibe-coding client for free OpenRouter models. Describe your app, choose a model, edit the generated code, and preview the result. Projects use React, JavaScript, Tailwind, and Vite. Run the client as a local web app or a Tauri desktop app.

## Get started

The local web app requires Node.js 22.12+ and npm:

```bash
npm ci
npm ci --prefix runtime/frontend --ignore-scripts --no-fund
npm run dev
```

Open [Open Vibe Coder](http://127.0.0.1:4179).

1. Create your own API key in [OpenRouter](https://openrouter.ai/settings/keys).
2. Open Settings, paste the key, and select **Save and connect**. This validates the key and catalogue without a model request.
3. Select **New project**. Creating and building the scaffold also works without an API key.
4. Describe your app and choose a free model or **Automatic**. Use **Model guide** to search the current catalogue.
5. Preview the result, edit files, and submit follow-up requests. **Rebuild** uses no AI. Optional planning uses one additional free model request.

Only text models with a current `:free` catalogue entry and zero prices are offered. The client rechecks this before every model request, sets zero-price provider limits, and never falls back to a paid model. Automatic selects an available free model. Quality, availability, and account limits vary. See the [OpenRouter models API](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties) and [free variants](https://openrouter.ai/docs/guides/routing/model-variants/free).

Your API key is stored in the local `.env.local`, excluded from Git and protected with restricted file permissions. It is not stored in browser storage. Requests and the required source context are sent to OpenRouter for code generation. Do not put secrets or sensitive data in prompts or project code.

## Version 0.3.0

The interface, accessibility labels, settings, errors, build feedback, model instructions, generated project scaffold, and project history use English. Dates and numbers use English formatting. Existing project data and desktop identifiers remain compatible; existing user content is not translated automatically.

Version 0.3.0 is synchronized across npm, Tauri, and Cargo. The macOS Apple Silicon app is built and locally ad-hoc signed; it is not notarized. The app is under `src-tauri/target/release/bundle/macos/`, with a distributable ZIP under `releases/`.

## Project structure

| Directory | Contents |
| --- | --- |
| `src/server/` | Local HTTP server and previews |
| `src/models/` | Model discovery, provider requests, and usage |
| `src/config/` | Local configuration and secret redaction |
| `src/projects/` | Project files, context, planning, connections, and history |
| `src/build/` | Sandboxed builds, worker, and compiler feedback |
| `src/execution/` | Runners, execution isolation, and acceptance validation |
| `src/parsing/` | Model responses, tool arguments, and heuristics |
| `src/ui/` | Interface source, static assets, and editor source |
| `src/paths.mjs` | Shared resource and data locations |
| `src-tauri/` | Rust desktop app, icons, and platform configuration |
| `templates/` | Project scaffold, portal UI, and connection clients |
| `runtime/frontend/` | Pinned React/Vite/Tailwind build dependencies |
| `runtime/specs/` | Model instructions, experiment contracts, and schema SQL |
| `scripts/` | Development, verification, and packaging scripts |
| `test/` | Client tests and the HR acceptance suite |
| `.local/` | Default projects and local runs; excluded from Git |
| `build/ui/` | Generated client interface; excluded from Git |

`npm run ui:build` generates the interface from `src/ui/`. Desktop packaging preserves the same backend layout. `src-tauri/target/`, `.desktop-backend/`, and `.desktop-cache/` contain local build output.

Without `BIM_CLIENT_DATA_DIR`, runs and default projects are stored under `.local/`. With that variable, runs stay under `<data-directory>/runs/`, preserving existing desktop data. The desktop app keeps its existing identifier and data directory.

## Verify and build

```bash
npm test
npm run ui:build
npm run selfcheck
npm run desktop:prepare
```

The execution self-check and sandboxed project builds require macOS. Windows execution isolation is not yet available; the Windows app has not been fully tested. Tests use local HTTP servers. `npm run check` checks local model configuration without calling a model. `npm run experiment` runs the legacy backend experiment.

For a desktop build, install Rust and the Tauri platform prerequisites, then run:

```bash
npm run desktop:build -- --keep-version --bundles app
```

`--keep-version` preserves 0.3.0. Without it, the build script increments the patch version as before. The desktop app bundles its Node runtime; end users do not need a separate Node installation.
