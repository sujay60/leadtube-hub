FROM node:20

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy application code
COPY . .

# Create directories for persistent data and uploads
RUN mkdir -p /data "/app/Bulk Email/uploads"

EXPOSE 8080

CMD ["node", "server.js"]
