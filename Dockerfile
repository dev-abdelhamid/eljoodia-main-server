FROM node:20-alpine

WORKDIR /app

# تثبيت Caddy
RUN apk add --no-cache caddy

# نسخ package.json وتثبيت الديبندنسيز (production فقط)
COPY package*.json ./
RUN npm install --only=production
# نسخ باقي الكود
COPY . .

# البورتات المطلوبة
EXPOSE 80 443 3000

# تشغيل Caddy + Node.js في الـ production
CMD sh -c "\
  if [ \"$NODE_ENV\" = \"production\" ]; then \
    echo 'Production Mode → Caddy + HTTPS + SSL'; \
    caddy run --config /app/Caddyfile --adapter caddyfile & node index.js; \
  else \
    echo 'Development Mode → Node.js only on :3000'; \
    node index.js; \
  fi"