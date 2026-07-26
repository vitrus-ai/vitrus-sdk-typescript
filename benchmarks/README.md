# SDK benchmarks

Benchmarks are intentionally split by data plane.

- `control`: lease/bootstrap and joint-target publish. Never includes camera bytes.
- `telemetry`: one normalized state snapshot or a native Zenoh subscription.
- `camera`: complete frame round trip, including capture, JPEG, transport, JSON/base64 and decode.

Run TypeScript benchmarks after building:

```bash
bun run build:typescript
bun benchmarks/typescript-roundtrip.ts
```

The output is JSON so it can be stored as a CI artifact. Set `VITRUS_API_URL` only when using a non-default Bridge. LAN Python/Zenoh benchmarks should run on the edge host or a peer with a routable Zenoh locator.
