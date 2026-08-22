FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates && rm -rf /var/lib/apt/lists/*
RUN python3 -m pip install --no-cache-dir --break-system-packages yt-dlp
WORKDIR /app
COPY package.json ./package.json
RUN npm install --omit=dev
COPY server.js worker.js cleanup.js combined.js storage.js ./
EXPOSE 8787
CMD ["node", "combined.js"]
