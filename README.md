# Ambrosia Instance Manager

Standalone local web app to manage isolated Docker-based Ambrosia instances.

## Requirements

- Docker with either `docker compose` or `docker-compose`
- A local Ambrosia source repo available on disk

By default, this manager expects the Ambrosia source repo at:

```bash
~/code/ambrosia
```

If your Ambrosia repo is elsewhere, set `AMBROSIA_SOURCE_DIR` before starting the manager.

## Start

```bash
cd ~/code/ambrosia-instance-manager
npm start
```

The UI runs on `http://127.0.0.1:3010` by default.

## Config

### `AMBROSIA_SOURCE_DIR`

Path to the Ambrosia repo used to build instance containers.

Example:

```bash
AMBROSIA_SOURCE_DIR=~/code/ambrosia npm start
```

### `INSTANCE_DATA_DIR`

Optional path for instance metadata and per-instance env files.

Example:

```bash
INSTANCE_DATA_DIR=~/.local/share/ambrosia-instance-manager npm start
```

## What it does

- Creates isolated Ambrosia instances with unique frontend, API, and Phoenixd ports
- Lists local instances and their runtime status
- Starts, stops, rebuilds, and deletes instances
- Exposes each instance with the laptop LAN IP so QR sharing works on the same network
- Tracks background jobs with progress so actions stay blocked until they finish

By default, instance metadata is stored in:

```bash
~/code/ambrosia-instance-manager/.ambrosia-instances
```
