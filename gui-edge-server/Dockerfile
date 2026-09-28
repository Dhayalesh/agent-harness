FROM --platform=$BUILDPLATFORM golang:1.22-bookworm AS builder

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

COPY cmd/gui-edge-server ./cmd/gui-edge-server
COPY server ./server
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=linux GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w" -o /app/gui-edge-server ./cmd/gui-edge-server

FROM alpine:3.22

WORKDIR /app
COPY --from=builder /app/gui-edge-server /app/gui-edge-server
USER 10001:10001

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/health || exit 1

ENTRYPOINT ["/app/gui-edge-server"]
CMD ["-listen", "0.0.0.0:8080"]
