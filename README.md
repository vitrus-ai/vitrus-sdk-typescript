# One SDK, any Droid

> A unified way to interface and control with robots running VitrusOS.

One SDK contract for Vitrus Droids across Web/JavaScript, TypeScript, Python, LAN mesh and the public Vitrus Bridge.

## Repository layout

- `typescript/` TypeScript/Web SDK and the browser-compatible contract.
- `python/` Python SDK with native Zenoh transport for edge devices.
- `benchmarks/` latency benchmarks separated by control, telemetry and camera data planes.
- `docs/` consolidated architecture and GitHub Pages documentation.

## Minimal configuration

```dotenv
VITRUS_DROID=VTRS-R06-2607-R2D2X
VITRUS_API_KEY=your-vitrus-api-key
```

The SDK resolves serials and aliases through the Bridge. No device token, robot IP, VPN address or Zenoh endpoint is required for the public client path.

## Data planes

```text
Web/JS ── HTTPS/WebSocket ── Vitrus Bridge ── outbound relay ── Zenoh ── VitrusOS
Python on edge ───────────────────────────── native Zenoh LAN ────────── VitrusOS
```

Motion, telemetry and camera data are benchmarked separately. Camera frames are intentionally not used as a control-loop transport.

Telemetry is publish/subscribe: VitrusOS reads the motor broker once and multiple Python, Web and UI clients consume the same normalized stream. Direct clients currently use the deployed compatibility snapshot on `vitrus/telemetry/state`; the typed stream can be enabled when its publisher is deployed. Camera video remains a separate WebRTC media plane.

## Development

```bash
bun install --cwd typescript
bun run check
```

For Python:

```bash
python3 -m venv .venv
.venv/bin/pip install -e python
.venv/bin/python -m pytest python/tests
```

The full documentation is available in [`docs/`](docs/index.html) and is published by the GitHub Pages workflow.
