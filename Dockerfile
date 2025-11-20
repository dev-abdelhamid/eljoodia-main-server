FROM node:20-alpine

WORKDIR /app

# تثبيت Caddy (أخف وأسرع من Nginx)
RUN apk add --no-cache caddy

# نسخ الملفات
COPY package*.json ./
RUN npm ci --only=production --ignore-scripts

COPY . .

# البورتات
EXPOSE 80 443 3000

# الذكاء كله هنا
CMD sh -c "\
  if [ \"$NODE_ENV\" = \"production\" ]; then \
    echo 'Production Mode → Caddy + HTTPS + SSL'; \
    caddy run --config /etc/caddy/Caddyfile --adapter caddyfile & node index.js; \
  else \
    echo 'Development Mode → Node.js only on :3000'; \
    node index.js; \
  fi"