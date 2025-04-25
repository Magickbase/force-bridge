FROM node:18.0.0-alpine AS builder

WORKDIR /opt/force-bridge

COPY . .

WORKDIR /opt/force-bridge/offchain-modules

# Install Python for node-gyp
RUN apk add --no-cache python3 make g++

# Install all dependencies
RUN yarn install --production

# Build the project
RUN yarn build

# Create a new stage for the final image
FROM node:18.0.0-alpine

WORKDIR /app

# Copy only the necessary files from the builder stage
COPY --from=builder /opt/force-bridge/offchain-modules/packages/app-cli/dist/index.js /app/index.js
COPY --from=builder /opt/force-bridge/offchain-modules/node_modules /app/node_modules

# Create a symbolic link for the executable
RUN ln -s /app/index.js /usr/local/bin/forcecli
