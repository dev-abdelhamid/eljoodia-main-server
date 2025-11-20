FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .

# Stage 2: الصورة النهائية (Caddy + Node كامل)
FROM caddy:2-alpine

# 👇 هذا السطر ضروري جدًا
COPY --from=builder /app/Caddyfile /etc/caddy/Caddyfile

# نسخ باقي الملفات والـ Node.js
COPY --from=builder /app /app
COPY --from=builder /usr/local /usr/local
COPY --from=builder /lib /lib
COPY --from=builder /usr/lib /usr/lib

ENV PATH=/usr/local/bin:$PATH
WORKDIR /app
EXPOSE 80 443 3000

CMD ["sh", "-c", "node index.js & caddy run --config /etc/caddy/Caddyfile --adapter caddyfile"]