#!/bin/bash

# Exit on error
set -e

# Set default database names if not provided
export BSC_DATABASE=${BSC_DATABASE:-bscverifier}
export GOERLI_DATABASE=${GOERLI_DATABASE:-verifier}

USE_DB_COMPOSE=true
UPDATE=false
for arg in "$@"; do
    if [ "$arg" = "--no-db" ]; then
        USE_DB_COMPOSE=false
    fi

    if [ "$arg" = "--update" ]; then
        UPDATE=true
    fi
done

if [ "$UPDATE" = false ]; then
# Check if running with root privileges
    if [ "$EUID" -ne 0 ]; then 
        echo "Please run this script with root privileges"
        exit 1
    fi

    # Check for BSC configuration files
    if [ ! -f "./force_bridge_bsc.json" ] || [ ! -f "./keystore_bsc.json" ]; then
        echo "Error: force_bridge_bsc.json or keystore_bsc.json not found in current directory"
        exit 1
    fi

    # Check for ETH configuration files
    if [ ! -f "./force_bridge_eth.json" ] || [ ! -f "./keystore_eth.json" ]; then
        echo "Error: force_bridge_eth.json or keystore_eth.json not found in current directory"
        exit 1
    fi

    # Create directories
    mkdir -p /root/bsc
    mkdir -p /root/eth

    # Create init.sql if it doesn't exist
    if [ ! -f "./init.sql" ]; then
        echo "Creating init.sql..."
        echo "CREATE DATABASE IF NOT EXISTS ${BSC_DATABASE};" > "./init.sql"
        echo "CREATE DATABASE IF NOT EXISTS ${GOERLI_DATABASE};" >> "./init.sql"
    fi

    # Copy BSC files with renamed format
    if [ -f "/root/bsc/force_bridge.json" ]; then
        rm -f "/root/bsc/force_bridge.json"
    fi
    cp "./force_bridge_bsc.json" "/root/bsc/force_bridge.json"

    if [ -f "/root/bsc/keystore.json" ]; then
        rm -f "/root/bsc/keystore.json"
    fi
    cp "./keystore_bsc.json" "/root/bsc/keystore.json"

    # Copy ETH files with renamed format
    if [ -f "/root/eth/force_bridge.json" ]; then
        rm -f "/root/eth/force_bridge.json"
    fi
    cp "./force_bridge_eth.json" "/root/eth/force_bridge.json"

    if [ -f "/root/eth/keystore.json" ]; then
        rm -f "/root/eth/keystore.json"
    fi
    cp "./keystore_eth.json" "/root/eth/keystore.json"

    echo "Configuration files copied successfully to /root/bsc and /root/eth"
fi

# Set GitHub raw content link
DEPLOY_DIR="/opt/deploy"

# Check if Docker is installed
if ! command -v docker >/dev/null 2>&1; then
    echo "Docker not installed, starting installation..."
    
    # Install required packages
    apt-get update
    apt-get install -y \
        apt-transport-https \
        ca-certificates \
        curl \
        gnupg \
        lsb-release

    # Add Docker official GPG key
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg

    # Set stable repository
    echo \
        "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu \
        $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null

    # Install Docker Engine
    apt-get update
    apt-get install -y docker-ce docker-ce-cli containerd.io
    
    echo "Docker installation complete"
else
    echo "Docker is already installed"
fi

# Check if Docker Compose is installed
if ! command -v docker-compose &> /dev/null; then
    echo "Docker Compose not installed, starting installation..."
    curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
    chmod +x /usr/local/bin/docker-compose
    echo "Docker Compose installation complete"
else
    echo "Docker Compose is already installed"
fi

# Create deployment directory
mkdir -p $DEPLOY_DIR

# Log file for updates
LOG_FILE="/var/log/force-bridge-update.log"

# Function to log messages
log_message() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') - $1" | tee -a "$LOG_FILE"
}

# Function to download configuration file
download_compose_file() {
    echo "Starting configuration file download..."
    
    # If old config exists, create backup
    if [ -f "$COMPOSE_FILE" ]; then
        cp "$COMPOSE_FILE" "${COMPOSE_FILE}.backup.$(date +%Y%m%d_%H%M%S)"
    fi
    
    # Download new config file
    if curl -sSL "$GITHUB_RAW_URL" -o "$COMPOSE_FILE"; then
        echo "Configuration file download complete"
    else
        echo "Error: Configuration file download failed"
        exit 1
    fi
    
    # Validate if file is valid YAML
    if ! docker-compose -f "$COMPOSE_FILE" config > /dev/null 2>&1; then
        echo "Error: Downloaded docker-compose.yml file is invalid"
        if [ -f "${COMPOSE_FILE}.backup.$(date +%Y%m%d_%H%M%S)" ]; then
            mv "${COMPOSE_FILE}.backup.$(date +%Y%m%d_%H%M%S)" "$COMPOSE_FILE"
            echo "Backup file restored"
        fi
        exit 1
    fi
}

# Function to ensure databases exist
ensure_databases() {
    echo "Ensuring databases exist..."
    
    # Wait for MySQL to be ready
    until docker exec mysql mysqladmin ping -h localhost -u root -p${MYSQL_ROOT_PASSWORD:-root} --silent; do
        echo "Waiting for MySQL to be ready..."
        sleep 2
    done
    
    # Create databases if they don't exist
    docker exec mysql mysql -u root -p${MYSQL_ROOT_PASSWORD:-root} -e "
        CREATE DATABASE IF NOT EXISTS ${BSC_DATABASE};
        CREATE DATABASE IF NOT EXISTS ${GOERLI_DATABASE};
    "
    
    echo "Databases check complete"
}

# Function to update docker-compose service
update_compose_service() {
    local compose_file="$DEPLOY_DIR/docker-compose.yml"
    
    # If old compose file exists, stop and remove old containers
    if [ -f "$compose_file" ]; then
        echo "Stopping existing containers..."
        cd $DEPLOY_DIR
        docker-compose down
        
        # Get all used images and remove them
        echo "Removing old images..."
        for image in $(grep "image:" $compose_file | awk '{print $2}'); do
            docker rmi $image || true
        done
    fi
    
    # Start new services
    echo "Starting services..."
    cd $DEPLOY_DIR

    FORCE_BRIDGE_KEYSTORE_PASSWORD=${FORCE_BRIDGE_KEYSTORE_PASSWORD:-123456} \
    MYSQL_ROOT_PASSWORD=${MYSQL_ROOT_PASSWORD:-root} \
    BSC_DATABASE=${BSC_DATABASE} \
    GOERLI_DATABASE=${GOERLI_DATABASE} \
    docker-compose up -d
    
    # Ensure databases exist
    if [ "$USE_DB_COMPOSE" = true ]; then
        ensure_databases
    fi
    
    echo "Service update complete"
}

# Function to check and update Docker images
update_docker_images() {
    local compose_file="$DEPLOY_DIR/docker-compose.yml"
    log_message "Checking for Docker image updates..."
    
    # Pull latest images
    cd $DEPLOY_DIR
    docker-compose pull
    
    # Get current image hashes
    local current_hashes=$(docker-compose images -q)
    
    # Pull new images
    docker-compose pull
    
    # Get new image hashes
    local new_hashes=$(docker-compose images -q)
    
    # Compare hashes to check if updates are available
    if [ "$current_hashes" == "$new_hashes" ]; then
        log_message "No new Docker images available"
        return 1
    fi
    
    # Clean up old images
    log_message "Cleaning up old Docker images..."
    docker image prune -a
}

COMPOSE_FILE="$DEPLOY_DIR/docker-compose.yml"
# Set the docker-compose file based on the parameter
if [ "$USE_DB_COMPOSE" = true ]; then
    GITHUB_RAW_URL="https://raw.githubusercontent.com/Magickbase/force-bridge/latest/docker-compose.yml"
else
    GITHUB_RAW_URL="https://raw.githubusercontent.com/Magickbase/force-bridge/latest/docker-compose-without-db.yml"
fi

echo "Starting deployment update..."

download_compose_file
if update_docker_images; then
    echo "Docker image updates available, updating service"
    update_compose_service
else
    echo "No Docker image updates available, skipping service update"
fi
rm -f "${DEPLOY_DIR}/docker-compose.yml.backup."*
echo "Deployment script execution complete"