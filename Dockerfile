FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY agent ./agent
COPY src ./src
COPY web ./web
COPY fixtures ./fixtures
COPY demo.ts ./
RUN mkdir -p out && chown node:node out
EXPOSE 3002
USER node
CMD ["node", "--import", "tsx", "src/server.ts"]
