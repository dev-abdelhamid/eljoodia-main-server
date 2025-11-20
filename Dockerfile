FROM node:20-alpine

WORKDIR /app

# تثبيت Caddy
RUN apk add --no-cache caddy

# نسخ package.json وتثبيت الديبندنسيز
COPY package*.json ./
RUN npm ci --only=production

# نسخ الكود كله
COPY . .

# تعريض البورتات
EXPOSE 80 443 3000

# تشغيل Caddy + Node.js
CMD ["sh", "-c", "caddy run --config /app/Caddyfile --adapter caddyfile & node index.js"]