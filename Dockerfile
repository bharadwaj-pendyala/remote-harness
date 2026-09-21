FROM node:22-bookworm-slim AS chat
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /harness
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY chat ./chat
RUN mkdir /data && chown node:node /data
USER node
RUN git config --global --add safe.directory /repository
ENV CHAT_HOST=0.0.0.0 CHAT_DATA_DIR=/data HARNESS_REPO=/repository
CMD ["node", "chat/main.mjs"]

FROM python:3.12-slim AS ui
WORKDIR /harness
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY ui ./ui
RUN useradd --create-home harness
USER harness
CMD ["streamlit", "run", "ui/app.py", "--server.address", "0.0.0.0", "--server.port", "8501"]
