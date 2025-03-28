#!/bin/bash

# Exit on error
set -e

# Check if running with root privileges
if [ "$EUID" -ne 0 ]; then 
    echo "Please run this script with root privileges"
    exit 1
fi

# Set GitHub raw content link
GITHUB_RAW_URL="https://raw.githubusercontent.com/Magickbase/force-bridge/v0.1.10/docker-compose.yml"
DEPLOY_DIR="/opt/deploy"

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
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

# Function to download configuration file
download_compose_file() {
    local compose_file="$DEPLOY_DIR/docker-compose.yml"
    
    echo "Starting configuration file download..."
    
    # If old config exists, create backup
    if [ -f "$compose_file" ]; then
        cp "$compose_file" "${compose_file}.backup.$(date +%Y%m%d_%H%M%S)"
    fi
    
    # Download new config file
    if curl -sSL "$GITHUB_RAW_URL" -o "$compose_file"; then
        echo "Configuration file download complete"
    else
        echo "Error: Configuration file download failed"
        exit 1
    fi
    
    # Validate if file is valid YAML
    if ! docker-compose -f "$compose_file" config > /dev/null 2>&1; then
        echo "Error: Downloaded docker-compose.yml file is invalid"
        if [ -f "${compose_file}.backup.$(date +%Y%m%d_%H%M%S)" ]; then
            mv "${compose_file}.backup.$(date +%Y%m%d_%H%M%S)" "$compose_file"
            echo "Backup file restored"
        fi
        exit 1
    fi
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

    FORCE_BRIDGE_KEYSTORE_PASSWORD=${FORCE_BRIDGE_KEYSTORE_PASSWORD:-123456} MYSQL_ROOT_PASSWORD=${MYSQL_ROOT_PASSWORD:-root} docker-compose up -d
    
    echo "Service update complete"
}

# Main process
echo "Starting deployment update..."
download_compose_file
update_compose_service
echo "Deployment script execution complete" 