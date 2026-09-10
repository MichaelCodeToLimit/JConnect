# JConnect Relay (optional)

JConnect prefers direct paths: the local network, Tailscale and other private routes. You don't need
this relay for any of those. Run it only when you want trusted devices to reach a computer that has
no direct or private path, for example a phone on cellular data reaching a home PC behind a router.

The relay is a pipe and holds no secrets:

- A computer keeps one outbound connection to the relay and proves who it is by signing with its own
  device key. Device ids come from those keys, so no one can register as someone else's computer.
- A trusted device asks the relay for that computer. The relay tells the computer, and the computer
  opens a tunnel back. The relay then passes bytes between the two.
- Pairing, trust and authorization still happen end to end between the two devices. The relay can't
  approve a device, and it can't pretend to be a computer.

## Run

```bash
cd server/relay
npm install
npm start
```

It listens on port `47880`. Set `PORT` to use a different one. Put it behind TLS (for example
Caddy or nginx with `wss://`) when it's reachable from the internet.

## Endpoints

| Path | Who | Purpose |
| --- | --- | --- |
| `ws /host` | computer | Send `{t:"register", id, publicKey, ts, sig}` where `sig` signs the UTF-8 text `jconnect-relay-register:<id>:<ts>`. Receives `{t:"incoming", tunnel}` whenever a device wants in. |
| `ws /connect?to=<id>` | trusted device | Waits until the computer accepts, then becomes a pipe. Closes with `4004` if the computer isn't reachable. |
| `ws /accept?tunnel=<token>` | computer | Opens the computer's side of that pipe. |
| `GET /presence?ids=a,b` | anyone | `{"online":[...]}`, used to show "Available through the internet". |
| `GET /health` | anyone | Liveness check. |

Close codes: `4003` bad registration, `4004` unreachable, `4029` busy.

## Test

```bash
npm test
```
