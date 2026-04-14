FROM node:20-alpine

WORKDIR /app

# Install dependencies first (layer cache)
COPY package*.json ./
RUN npm install --omit=dev

# Copy source
COPY src/ ./src/
COPY public/ ./public/

# Persistent data volume
VOLUME ["/app/data"]

EXPOSE 3000

CMD ["node", "src/bridge.js"]
