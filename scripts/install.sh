#!/usr/bin/env bash
# =============================================================================
# Aivory VPS Panel — One-Line Install Script
# =============================================================================
# Usage:
#   curl -fsSL https://panel.aivory.id/install.sh | bash
#
# Supported distributions:
#   - Debian 11 (Bullseye)
#   - Debian 12 (Bookworm)
#   - Ubuntu 20.04 (Focal)
#   - Ubuntu 22.04 (Jammy)
#   - Ubuntu 24.04 (Noble)
#
# Requirements:
#   - Root or sudo access
#   - Minimum 1 CPU core, 1 GB RAM, 10 GB disk
#   - Internet connectivity (minimum 10 Mbps recommended)
#
# This script is idempotent — re-running it will detect existing installations,
# preserve configuration, and update the VPS Panel image without data loss.
# =============================================================================

set -euo pipefail

# --- Configuration -----------------------------------------------------------

PANEL_NAME="aivory-vps-panel"
PANEL_DIR="/opt/aivery/vps-panel"
PANEL_IMAGE="ghcr.io/aivory/vps-panel:latest"
PANEL_PORT="${PANEL_PORT:-3000}"
NETWORK_NAME="aivery-network"
LOG_FILE="/var/log/vps-panel-install.log"
MIN_RAM_MB=1024
MIN_DISK_GB=10

# --- Colors and output helpers -----------------------------------------------

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; }

log() {
  local timestamp
  timestamp=$(date '+%Y-%m-%d %H:%M:%S')
  echo "[$timestamp] $*" >> "$LOG_FILE"
}

die() {
  error "$*"
  log "FATAL: $*"
  echo ""
  echo "Installation failed. See $LOG_FILE for details."
  exit 1
}

# --- Pre-flight checks -------------------------------------------------------

check_root() {
  if [ "$(id -u)" -ne 0 ]; then
    die "This script must be run as root. Use: sudo bash or run as root."
  fi
}

detect_os() {
  if [ ! -f /etc/os-release ]; then
    die "Cannot detect operating system. /etc/os-release not found."
  fi

  # shellcheck disable=SC1091
  . /etc/os-release

  OS_ID="${ID:-unknown}"
  OS_VERSION="${VERSION_ID:-unknown}"
  OS_NAME="${PRETTY_NAME:-unknown}"

  log "Detected OS: $OS_NAME (ID=$OS_ID, VERSION=$OS_VERSION)"

  case "$OS_ID" in
    debian)
      case "$OS_VERSION" in
        11|12) ;;
        *) unsupported_os ;;
      esac
      ;;
    ubuntu)
      case "$OS_VERSION" in
        20.04|22.04|24.04) ;;
        *) unsupported_os ;;
      esac
      ;;
    *)
      unsupported_os
      ;;
  esac

  success "Operating system supported: $OS_NAME"
}

unsupported_os() {
  error "Unsupported operating system detected: ${OS_NAME:-unknown}"
  echo ""
  echo "Supported distributions:"
  echo "  - Debian 11 (Bullseye)"
  echo "  - Debian 12 (Bookworm)"
  echo "  - Ubuntu 20.04 (Focal)"
  echo "  - Ubuntu 22.04 (Jammy)"
  echo "  - Ubuntu 24.04 (Noble)"
  echo ""
  log "FATAL: Unsupported OS: $OS_NAME (ID=$OS_ID, VERSION=$OS_VERSION)"
  exit 1
}

check_resources() {
  info "Checking system resources..."

  # Check RAM
  local total_ram_kb
  total_ram_kb=$(grep MemTotal /proc/meminfo | awk '{print $2}')
  local total_ram_mb=$((total_ram_kb / 1024))

  if [ "$total_ram_mb" -lt "$MIN_RAM_MB" ]; then
    die "Insufficient RAM: ${total_ram_mb}MB available, minimum ${MIN_RAM_MB}MB required."
  fi
  success "RAM: ${total_ram_mb}MB (minimum ${MIN_RAM_MB}MB)"

  # Check disk space
  local available_disk_gb
  available_disk_gb=$(df -BG / | awk 'NR==2 {print $4}' | tr -d 'G')

  if [ "$available_disk_gb" -lt "$MIN_DISK_GB" ]; then
    die "Insufficient disk space: ${available_disk_gb}GB available, minimum ${MIN_DISK_GB}GB required."
  fi
  success "Disk: ${available_disk_gb}GB available (minimum ${MIN_DISK_GB}GB)"
}

# --- Docker installation -----------------------------------------------------

is_docker_installed() {
  command -v docker &>/dev/null && docker info &>/dev/null
}

is_compose_installed() {
  docker compose version &>/dev/null 2>&1
}

install_docker() {
  if is_docker_installed; then
    local docker_version
    docker_version=$(docker --version)
    success "Docker already installed: $docker_version"
    log "Docker already installed: $docker_version"
  else
    info "Installing Docker Engine..."
    log "Installing Docker Engine on $OS_ID $OS_VERSION"

    # Remove old packages that might conflict
    apt-get remove -y docker docker-engine docker.io containerd runc 2>/dev/null || true

    # Install prerequisites
    apt-get update -y >> "$LOG_FILE" 2>&1
    apt-get install -y \
      ca-certificates \
      curl \
      gnupg \
      lsb-release >> "$LOG_FILE" 2>&1

    # Add Docker's official GPG key
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL "https://download.docker.com/linux/$OS_ID/gpg" \
      | gpg --dearmor -o /etc/apt/keyrings/docker.gpg 2>> "$LOG_FILE"
    chmod a+r /etc/apt/keyrings/docker.gpg

    # Set up the repository
    local arch
    arch=$(dpkg --print-architecture)
    local codename
    codename=$(. /etc/os-release && echo "$VERSION_CODENAME")

    echo \
      "deb [arch=$arch signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$OS_ID $codename stable" \
      > /etc/apt/sources.list.d/docker.list

    # Install Docker Engine and Compose plugin
    apt-get update -y >> "$LOG_FILE" 2>&1
    apt-get install -y \
      docker-ce \
      docker-ce-cli \
      containerd.io \
      docker-buildx-plugin \
      docker-compose-plugin >> "$LOG_FILE" 2>&1

    # Start and enable Docker
    systemctl start docker
    systemctl enable docker

    if ! is_docker_installed; then
      die "Docker installation failed. Check $LOG_FILE for details."
    fi

    success "Docker Engine installed successfully"
    log "Docker installed: $(docker --version)"
  fi

  # Verify Docker Compose plugin
  if is_compose_installed; then
    success "Docker Compose plugin available: $(docker compose version)"
  else
    die "Docker Compose plugin not available after installation."
  fi
}

# --- Panel directory and configuration ----------------------------------------

setup_panel_directory() {
  info "Setting up panel directory at $PANEL_DIR..."

  mkdir -p "$PANEL_DIR"
  mkdir -p "$PANEL_DIR/data"
  mkdir -p /etc/ssl/vps-panel
  mkdir -p /opt/aivery

  success "Panel directory created: $PANEL_DIR"
  log "Panel directory ready: $PANEL_DIR"
}

generate_env_file() {
  local env_file="$PANEL_DIR/.env"

  if [ -f "$env_file" ]; then
    info "Existing .env file found — preserving configuration"
    log "Preserving existing .env at $env_file"
    return 0
  fi

  info "Generating environment configuration..."

  # Generate a random JWT secret
  local jwt_secret
  jwt_secret=$(openssl rand -hex 32 2>/dev/null || head -c 64 /dev/urandom | base64 | tr -d '\n' | head -c 64)

  cat > "$env_file" <<EOF
# Aivory VPS Panel — Environment Configuration
# Generated on $(date -u '+%Y-%m-%d %H:%M:%S UTC')

# Panel port (internal)
PORT=${PANEL_PORT}

# JWT secret for session management
SUPABASE_JWT_SECRET=${jwt_secret}

# Docker socket path
DOCKER_HOST=/var/run/docker.sock

# Environment
ENVIRONMENT=production

# Database path (inside container)
DB_PATH=/app/data/panel.db

# Admin credentials (set during install)
ADMIN_USERNAME=
ADMIN_PASSWORD=
EOF

  chmod 600 "$env_file"
  success "Environment file generated: $env_file"
  log "Generated .env file at $env_file"
}

prompt_credentials() {
  local env_file="$PANEL_DIR/.env"

  # Check if credentials are already set
  local existing_user
  existing_user=$(grep -E '^ADMIN_USERNAME=' "$env_file" 2>/dev/null | cut -d'=' -f2)
  if [ -n "$existing_user" ]; then
    info "Admin credentials already configured (user: $existing_user)"
    return 0
  fi

  echo ""
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BLUE}  Configure Admin Credentials${NC}"
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""

  local username=""
  while [ -z "$username" ]; do
    read -rp "  Admin username: " username
    if [ -z "$username" ]; then
      warn "Username cannot be empty."
    fi
  done

  local password=""
  while [ -z "$password" ]; do
    read -rsp "  Admin password: " password
    echo ""
    if [ ${#password} -lt 8 ]; then
      warn "Password must be at least 8 characters."
      password=""
    fi
  done

  # Confirm password
  local confirm=""
  read -rsp "  Confirm password: " confirm
  echo ""

  if [ "$password" != "$confirm" ]; then
    die "Passwords do not match."
  fi

  # Update .env file
  sed -i "s/^ADMIN_USERNAME=.*/ADMIN_USERNAME=$username/" "$env_file"
  sed -i "s/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=$password/" "$env_file"

  echo ""
  success "Admin credentials configured"
  log "Admin user configured: $username"
}

generate_compose_file() {
  local compose_file="$PANEL_DIR/docker-compose.yml"

  if [ -f "$compose_file" ]; then
    info "Existing docker-compose.yml found — preserving configuration"
    log "Preserving existing docker-compose.yml at $compose_file"
    return 0
  fi

  info "Generating docker-compose.yml..."

  cat > "$compose_file" <<EOF
version: "3.8"

services:
  vps-panel:
    image: ${PANEL_IMAGE}
    container_name: ${PANEL_NAME}
    restart: unless-stopped
    ports:
      - "\${PORT:-${PANEL_PORT}}:3000"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - panel-data:/app/data
      - /opt/aivery:/opt/aivery
      - /etc/nginx:/etc/nginx
      - /etc/ssl/vps-panel:/etc/ssl/vps-panel
    environment:
      - PORT=\${PORT:-3000}
      - SUPABASE_JWT_SECRET=\${SUPABASE_JWT_SECRET}
      - DOCKER_HOST=/var/run/docker.sock
      - ENVIRONMENT=\${ENVIRONMENT:-production}
      - DB_PATH=/app/data/panel.db
      - ADMIN_USERNAME=\${ADMIN_USERNAME}
      - ADMIN_PASSWORD=\${ADMIN_PASSWORD}
    networks:
      - aivery-network
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 5s
      start_period: 30s
      retries: 3

volumes:
  panel-data:
    driver: local

networks:
  aivery-network:
    external: true
EOF

  success "docker-compose.yml generated: $compose_file"
  log "Generated docker-compose.yml at $compose_file"
}

# --- Network and image --------------------------------------------------------

create_network() {
  if docker network inspect "$NETWORK_NAME" &>/dev/null; then
    success "Docker network '$NETWORK_NAME' already exists"
    log "Network $NETWORK_NAME already exists"
  else
    info "Creating Docker bridge network: $NETWORK_NAME..."
    docker network create "$NETWORK_NAME" >> "$LOG_FILE" 2>&1
    success "Docker network '$NETWORK_NAME' created"
    log "Created network: $NETWORK_NAME"
  fi
}

pull_image() {
  info "Pulling VPS Panel image: $PANEL_IMAGE..."
  log "Pulling image: $PANEL_IMAGE"

  if docker pull "$PANEL_IMAGE" >> "$LOG_FILE" 2>&1; then
    success "Image pulled: $PANEL_IMAGE"
    log "Image pull successful: $PANEL_IMAGE"
  else
    warn "Could not pull image from registry. Attempting local build..."
    log "Image pull failed, attempting local build"
    build_image
  fi
}

build_image() {
  local repo_dir="/tmp/vps-panel-build"

  info "Cloning repository for local build..."
  log "Cloning repository for local build"

  rm -rf "$repo_dir"

  if git clone --depth 1 https://github.com/aivory/vps-panel.git "$repo_dir" >> "$LOG_FILE" 2>&1; then
    info "Building Docker image locally (this may take a few minutes)..."
    if docker build -t "$PANEL_IMAGE" "$repo_dir/vps" >> "$LOG_FILE" 2>&1; then
      success "Image built successfully"
      log "Local image build successful"
    else
      die "Docker image build failed. Check $LOG_FILE for details."
    fi
    rm -rf "$repo_dir"
  else
    die "Could not pull image or clone repository. Check network connectivity and $LOG_FILE."
  fi
}

# --- Start the panel ----------------------------------------------------------

start_panel() {
  info "Starting VPS Panel..."
  log "Starting VPS Panel container"

  cd "$PANEL_DIR"

  # Stop existing container if running (for updates)
  if docker ps -q -f "name=$PANEL_NAME" | grep -q .; then
    info "Stopping existing panel container for update..."
    docker compose down >> "$LOG_FILE" 2>&1 || true
  fi

  # Start with docker compose
  if docker compose up -d >> "$LOG_FILE" 2>&1; then
    success "VPS Panel container started"
    log "Container started successfully"
  else
    die "Failed to start VPS Panel container. Check $LOG_FILE for details."
  fi

  # Wait for health check
  info "Waiting for panel to become ready..."
  local retries=0
  local max_retries=30

  while [ $retries -lt $max_retries ]; do
    if curl -sf "http://localhost:${PANEL_PORT}/health" &>/dev/null; then
      success "VPS Panel is healthy and ready"
      log "Health check passed"
      return 0
    fi
    retries=$((retries + 1))
    sleep 2
  done

  warn "Panel started but health check did not pass within 60 seconds."
  warn "The panel may still be initializing. Check: docker logs $PANEL_NAME"
  log "WARNING: Health check did not pass within timeout"
}

# --- Output results -----------------------------------------------------------

get_server_ip() {
  # Try multiple methods to detect the server's public IP
  local ip=""
  ip=$(curl -sf --max-time 5 https://ifconfig.me 2>/dev/null) \
    || ip=$(curl -sf --max-time 5 https://api.ipify.org 2>/dev/null) \
    || ip=$(hostname -I 2>/dev/null | awk '{print $1}') \
    || ip="<server-ip>"
  echo "$ip"
}

print_summary() {
  local server_ip
  server_ip=$(get_server_ip)

  echo ""
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${GREEN}  ✓ Aivory VPS Panel — Installation Complete${NC}"
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
  echo -e "  ${BLUE}Access URL:${NC}  http://${server_ip}:${PANEL_PORT}"
  echo ""
  echo -e "  ${BLUE}Panel directory:${NC}  $PANEL_DIR"
  echo -e "  ${BLUE}Data volume:${NC}      panel-data"
  echo -e "  ${BLUE}Log file:${NC}         $LOG_FILE"
  echo ""
  echo "  Useful commands:"
  echo "    docker logs $PANEL_NAME        — View panel logs"
  echo "    docker compose -f $PANEL_DIR/docker-compose.yml restart  — Restart"
  echo "    docker compose -f $PANEL_DIR/docker-compose.yml down     — Stop"
  echo ""
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""

  log "Installation complete. Access: http://${server_ip}:${PANEL_PORT}"
}

# --- Main installation flow ---------------------------------------------------

main() {
  echo ""
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BLUE}  Aivory VPS Panel — Installer${NC}"
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""

  # Initialize log file
  mkdir -p "$(dirname "$LOG_FILE")"
  echo "=== Aivory VPS Panel Install — $(date -u '+%Y-%m-%d %H:%M:%S UTC') ===" > "$LOG_FILE"

  # Step 1: Pre-flight checks
  info "Running pre-flight checks..."
  check_root
  detect_os
  check_resources
  echo ""

  # Step 2: Install Docker if needed
  info "Checking Docker installation..."
  install_docker
  echo ""

  # Step 3: Set up panel directory and configuration
  setup_panel_directory
  generate_env_file
  prompt_credentials
  generate_compose_file
  echo ""

  # Step 4: Create Docker network
  create_network
  echo ""

  # Step 5: Pull or build the panel image
  pull_image
  echo ""

  # Step 6: Start the panel
  start_panel

  # Step 7: Print summary
  print_summary
}

# Run main
main "$@"
