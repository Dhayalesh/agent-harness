# Go GUI Edge Server POC

Independent Go WebSocket relay for the Go `edge-gui.exe`. It registers devices and relays MCP JSON-RPC messages; it does not import `sapgui.mcp`, control SAP GUI, or use the existing production `edge-server`.

## Build and run

Go 1.22+ is required.

```powershell
cd gui-edge-server
.\build.ps1
.\dist\gui-edge-server.exe -listen 127.0.0.1:8765
```

`GET http://127.0.0.1:8765/health` returns `{"status":"ok"}`. Both clients and connectors connect to `ws://127.0.0.1:8765/ws`. For remote use, terminate TLS at a trusted reverse proxy and use `wss://` from the connector.

## Relay protocol

JSON messages have `version:1`, `type`, `requestId` and `payload`. The connector sends `edge.register` with `email`, `deviceId` and `payload.mcpId:"sapgui"`; the server answers `edge.registered` with `connectionId`. `edge.heartbeat` gets `edge.heartbeat_ack`.

Clients send `mcp.request` with `email` and `payload:{"mcpId":"sapgui","message":<MCP JSON-RPC>}`. The server routes by email plus MCP ID to one connected GUI device. The connector returns `mcp.response` with `payload.message` holding the complete upstream JSON-RPC response. The server preserves tool definitions, image blocks and other MCP content. Supported methods are `initialize`, `notifications/initialized`, `tools/list`, `tools/call` and `ping`. A notification has no response. Errors use `edge.error` with `payload.code`.

Connections and pending requests are cleaned up on disconnect. Requests expire after 120 seconds. Messages are limited to 16 MiB. The POC has no authentication, so keep it on a trusted test network until access control is added. Request IDs must be unique across concurrent clients.

## Tests and read-only probe

```powershell
$env:GOCACHE = Join-Path $PWD '.gocache'
go test ./...
go run ./cmd/probe -url ws://127.0.0.1:8765/ws -email gui-poc@company.com
```

The Go probe sends MCP initialize, tools/list and a read-only `sap_list_connections` call. It prints only the upstream server name, tool count and content block count.

## AWS EC2 Ubuntu: Docker deployment

Use an Ubuntu EC2 host with Docker Engine and the `gui-edge-server` source. Check the instance architecture before building:

```sh
uname -m
```

The commands below assume `x86_64` (Linux AMD64). For `aarch64` (Linux ARM64), build with `docker build --platform linux/arm64 -t trueai-gui-edge-server:latest .` instead. The Dockerfile selects the Go target architecture from the Docker build platform. It builds a static Linux binary with CGO disabled, and the runtime container runs as a non-root user.

### Install Docker Engine

On an Ubuntu host without Docker, install Docker Engine from [Docker's official Ubuntu apt repository](https://docs.docker.com/engine/install/ubuntu/):

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin
sudo systemctl enable --now docker
sudo docker version
```

If Docker is already installed, use the existing installation. Run the following commands from the `gui-edge-server` directory.

### Build and run

```sh
sudo docker build -t trueai-gui-edge-server:latest .
sudo docker images trueai-gui-edge-server
sudo docker run -d \
  --name trueai-gui-edge-server \
  -p 127.0.0.1:8080:8080 \
  --restart unless-stopped \
  trueai-gui-edge-server:latest
```

The host port is bound to loopback only. The container listens on `0.0.0.0:8080`; a future HTTPS/WSS reverse proxy can connect to `127.0.0.1:8080` on the host. Do not publish this POC relay publicly: its WebSocket endpoint currently has no authentication. No SAP GUI software, credentials, certificates, or Windows connector are needed in this container.

### Check health and logs

```sh
sudo docker ps --filter name=trueai-gui-edge-server
curl -i http://127.0.0.1:8080/health
sudo docker inspect --format '{{.State.Health.Status}}' trueai-gui-edge-server
sudo docker logs -f trueai-gui-edge-server
```

`GET /health` returns HTTP 200 with `{"status":"ok"}`. Docker checks that endpoint from inside the container. The EC2 host can reach the WebSocket endpoint at `ws://127.0.0.1:8080/ws`; remote clients and the Windows GUI connector will use a WSS endpoint after a reverse proxy is configured.

With a Windows GUI connector registered through the relay, run the existing read-only probe on the EC2 host if Go is installed there, or through an SSH tunnel to its loopback port:

```sh
go run ./cmd/probe -url ws://127.0.0.1:8080/ws -email REGISTERED_CONNECTOR_EMAIL
```

The probe verifies MCP initialize, tools/list, and `sap_list_connections` through the relay. The Go test suite covers WebSocket registration, acknowledgement, heartbeat, and MCP request/response forwarding without a live connector: `go test ./...`.

### Stop, restart, and update

```sh
sudo docker stop trueai-gui-edge-server
sudo docker restart trueai-gui-edge-server
```

After replacing the source with the new version, rebuild and recreate the container:

```sh
sudo docker build -t trueai-gui-edge-server:latest .
sudo docker stop trueai-gui-edge-server || true
sudo docker rm trueai-gui-edge-server || true
sudo docker run -d \
  --name trueai-gui-edge-server \
  -p 127.0.0.1:8080:8080 \
  --restart unless-stopped \
  trueai-gui-edge-server:latest
curl -i http://127.0.0.1:8080/health
```
