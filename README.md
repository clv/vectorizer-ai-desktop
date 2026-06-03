# Vectorizer.AI Desktop

Vectorizer.AI Desktop is a lightweight Tauri app for local batch vectorization workflows. It complements the Vectorizer.AI website and CLI:

- Website: interactive review, zoom/pan, and palette editing.
- CLI: scripts and automation.
- Desktop app: local file/folder queues, output presets, saved credentials, and handoff links back to the website for detailed review.

The desktop app calls the public Vectorizer.AI API. It does not embed the vectorization algorithm.

## Current Capabilities

- Add raster images or recursively add folders.
- Drag and drop files/folders into the queue.
- Choose output format: SVG, PDF, EPS, DXF, or PNG.
- Choose API mode: production, preview, test, or test preview.
- Save API Secret in the operating system credential store.
- Save non-secret preferences in the user config directory.
- Run queued jobs sequentially and save results to a local output folder.
- Show credits charged/calculated when returned by the API.
- Preserve retained Image Tokens when retention is enabled.
- Open saved output files, reveal them in the file manager, or open retained results on vectorizer.ai for inspection/editing.

## Development

Prerequisites:

- Node.js
- Rust stable toolchain
- Platform requirements for Tauri v2

Install dependencies:

```powershell
npm install
```

Run the frontend build:

```powershell
npm run build
```

Run Rust checks:

```powershell
cd src-tauri
cargo check
```

Run the app in development:

```powershell
npm run tauri dev
```

Build desktop bundles:

```powershell
npm run tauri build
```

## Release Builds

GitHub Actions checks the app on Windows, macOS, and Ubuntu. To create a draft release with platform bundles, push a tag that starts with `desktop-v`:

```powershell
git tag desktop-v0.1.0
git push origin desktop-v0.1.0
```

The release workflow uses `tauri-apps/tauri-action` and uploads the generated installers as draft release assets for review before publication.

## API Credentials

The app asks for the Vectorizer.AI API Id and API Secret. If credential saving is enabled, only the secret is written to the operating system credential store. The API Id and other preferences are stored in the app settings JSON.

Environment variables are not required.

## Handoff To Website

When `Review links` is enabled, the app sends `policy.retention_days` with each vectorization request. If the API returns `X-Image-Token`, the job row includes a link to:

```text
https://vectorizer.ai/images/{IMAGE_TOKEN}
```

That keeps the desktop app focused on local batch workflow while reusing the existing website for detailed inspection and palette editing.
